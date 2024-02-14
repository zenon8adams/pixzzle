/* viewer.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const {
  Clutter,
  Cogl,
  Gio,
  GObject,
  GLib,
  Graphene,
  Meta,
  Shell,
  St,
  GdkPixbuf,
  Soup,
  Pango
} = imports.gi;

/*
 * Import only what you need as importing Gdk in shell process is
 * not allowed.
 * https://gjs.guide/extensions/review-guidelines/review-guidelines.html
 * #do-not-import-gtk-libraries-in-gnome-shell
 */
const { cairo_set_source_pixbuf } = imports.gi.Gdk;

const Cairo = imports.cairo;
const Util = imports.misc.util;
const File = Gio.File;
const Main = imports.ui.main;
const GrabHelper = imports.ui.grabHelper;
const Animator = imports.ui.animation;
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
const _ = Gettext.domain('pixzzle').gettext;

const {
  inflateSettings,
  SCHEMA_NAME,
  lg,
  getShotsLocation,
  getThumbnailsLocation,
  getDate,
  filesDateSorter,
  fmt
} = Me.imports.utils;
const { UIShutter } = Me.imports.screenshot;
const { computePanelPosition } = Me.imports.panel;
const Panel = computePanelPosition();
const Prefs = Me.imports.prefs;
const { getActionWatcher } = Me.imports.watcher;
const { Timer } = Me.imports.timer;
const { UITooltip } = Me.imports.tooltip;

const INITIAL_WIDTH = 500;
const INITIAL_HEIGHT = 600;
const ALLOWANCE = 80;
const EDGE_THRESHOLD = 2;
const FULLY_OPAQUE = 255;
const MODAL_CHECK_INTERVAL = 300;
const FRAME_SIZE = 64;
const FRAME_RATE = 15;
/*
 * Store metadata in image ancillary chunk
 * to detect if the image is smaller than
 * the size of thumbnail view. This kinds
 * of images are blurred to reduce pixellation.
 */
const TINY_IMAGE = 'tINy';

const OCR_URL = 'http://api.ocr.space/parse/image';

let SETTING_DISABLE_TILE_MODE;
let SETTING_NATURAL_PANNING;
let SETTING_OCR_API;

const ViewMode = Object.freeze({
  ADAPTIVE: Symbol('adaptive'),
  TILE: Symbol('tile')
});
var UIMainViewer = GObject.registerClass(
  {
    Signals: { 'drag-started': {}, 'drag-ended': {} }
  },
  class UIMainViewer extends St.Widget {
    _init(params) {
      lg('[UIMainViewer::_init]');

      super._init({
        name: 'UIMainViewer',
        layout_manager: new Clutter.BinLayout(),
        opacity: 0,
        visible: false,
        reactive: true,
        can_focus: true
      });

      this._dragButton = 0;
      this._dragSequence = null;

      this._startX = -1;
      this._startY = 0;
      this._lastX = 0;
      this._lastY = 0;

      this._isActive = false;
      this._viewMode = ViewMode.ADAPTIVE;
      this._tilingDisabled = false;
      this._emptyView = true;
      this._isFlattened = new GBoolean(true);

      Main.layoutManager.addChrome(this);

      /*
       * Watch for new modal dialog and hide viewer
       * when there's a change in the number of dialogs
       * visible as defined by `Main.modalCount`.
       */
      this._modalWatcher = getActionWatcher(this).addWatch(
        MODAL_CHECK_INTERVAL,
        {
          reaction: this._close.bind(this, true /* instantly */),
          compare: (one, other) => one === other,
          action: () => Main.modalCount
        }
      );

      this.reset();

      this._closeButton = new St.Button({
        style_class: 'pixzzle-ui-close-button',
        child: new St.Icon({ icon_name: 'preview-close-symbolic' }),
        x: 0,
        y: 0
      });
      /*
       *  Move the close button within its parent
       *  by factor 1. 0 means left-most end, 1
       *  means right-most end.
       *  The pivot_point indicates the part of
       *  the close button to align
       *  If the figure below is the close button,
       *  to set the anchor point of the button
       *  with which it will attach to its
       *  parent, set pivot point to (0.5, 0.5).
       *  +---------+
       *  |         |
       *  |    *    |
       *  |         |
       *  +---------+
       *   - factor -
       */
      this._closeButton.add_constraint(
        new Clutter.AlignConstraint({
          source: this,
          align_axis: Clutter.AlignAxis.X_AXIS,
          pivot_point: new Graphene.Point({ x: 1, y: 0 }),
          factor: 1
        })
      );
      this._closeButton.add_constraint(
        new Clutter.AlignConstraint({
          source: this,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          pivot_point: new Graphene.Point({ x: 0, y: 0 }),
          factor: 0
        })
      );
      this._closeButton.connect('clicked', this._close.bind(this));
      /*
       * vfunc_release_event is not triggered if we drag into the
       * zone of a reactive widget. We forcefully stop drag.
       */
      this._closeButton.connect('enter-event', this._stopDrag.bind(this));
      this.add_child(this._closeButton);

      this._topMostContainer = new UILayout({
        name: 'UIMainViewerLayout',
        vertical: true,
        x_expand: true,
        y_expand: true
      });
      this.add_child(this._topMostContainer);

      this._splitViewXContainer = new UILayout({
        name: 'UISplitViewLayout',
        vertical: false,
        x_expand: true,
        reactive: true
      });
      this._topMostContainer.add_child(this._splitViewXContainer);

      this._swapViewContainer = new UILayout({
        name: 'UISwapViewContainer',
        vertical: true,
        x_expand: false,
        reactive: true
      });

      this._bigViewContainer = new UILayout({
        name: 'UIBigViewLayout',
        x_expand: true,
        y_expand: false,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER
      });

      this._buttonBox = new UILayout({
        name: 'UIButtonBox',
        vertical: false,
        x_expand: true,
        x_align: Clutter.ActorAlign.END
      });
      this._topMostContainer.add_child(this._buttonBox);

      this._settingsButton = new UIButton({
        style_class: 'pixzzle-ui-settings-button',
        child: new St.Icon({ icon_name: 'org.gnome.Settings-symbolic' }),
        x_expand: false,
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        rotation_angle_z: 0
      });
      this._buttonBox.add_child(this._settingsButton);
      this._settingsButton.set_pivot_point(0.5, 0.5);
      this._settingsButton.connect(
        'notify::hover',
        this._animateSettings.bind(this)
      );
      this._settingsButton.connect('clicked', this._openSettings.bind(this));
      this._settingsButton.connect('enter-event', this._stopDrag.bind(this));

      this._settingsButtonTooltip = new UITooltip(this._settingsButton, {
        text: _('Open settings'),
        style_class: 'pixzzle-ui-tooltip',
        visible: false
      });
      this.connect('destroy', () => {
        Main.uiGroup.remove_actor(this._settingsButtonTooltip);
        this._settingsButtonTooltip.destroy();
      });
      Main.uiGroup.add_child(this._settingsButtonTooltip);

      this._thumbnailControls = new UILayout({
        name: 'UIThumbnailControls',
        x_align: Clutter.ActorAlign.END,
        x_expand: true
      });
      this._screenshotButton = new UIButton({
        label: _('Add New'),
        x_expand: false,
        x_align: Clutter.ActorAlign.END,
        reactive: true,
        style_class: 'pixzzle-ui-screenshot-button'
      });
      const iconName = 'pixzzle-ui-swap-symbolic.svg';
      this._swapIcon = new St.Icon({
        gicon: Gio.icon_new_for_string(`${Me.path}/icons/${iconName}`),
        rotation_angle_z: 0
      });
      this._swapButton = new UIButton({
        style_class: 'pixzzle-ui-swap-button',
        child: this._swapIcon,
        x_expand: false,
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        toggle_mode: true
      });
      this._swapIcon.set_pivot_point(0.5, 0.5);
      this._swapButton.connect('notify::checked', (widget) => {
        if (!this._thumbnailView.loading) {
          this._toggleSwap(widget);
        }
      });

      this._swapButtonTooltip = new UITooltip(this._swapButton, {
        text: _('Show/Hide group'),
        style_class: 'pixzzle-ui-tooltip',
        visible: false
      });
      this.connect('destroy', () => {
        Main.uiGroup.remove_actor(this._swapButtonTooltip);
        this._swapButtonTooltip.destroy();
      });

      Main.uiGroup.add_child(this._swapButtonTooltip);
      this._buttonBox.add_child(this._thumbnailControls);
      this._thumbnailControls.add_child(this._screenshotButton);
      this._thumbnailControls.add_child(this._swapButton);
      this._screenshotButton.connect('clicked', () =>
        this._showScreenshotView()
      );
      this._screenshotButton.connect('enter-event', this._stopDrag.bind(this));

      this._folderView = new UIFolderViewer({
        name: 'UIFolderViewer',
        x_expand: false,
        visible: false,
        height: 0
      });
      this._folderView.connect('swap-view', (widget, payload) => {
        this._thumbnailView.reload(payload, () => {
          this._swapButton.checked = false;
          this._groupingEnabled = !!payload.date;
        });
      });
      this._folderView.connect('enter-event', this._stopDrag.bind(this));

      this._thumbnailView = new UIThumbnailViewer(this._folderView, {
        name: 'UIThumbnailViewer',
        x_expand: false,
        visible: true
      });

      this._thumbnailView.connect('replace', (_, shot) => {
        this._imageViewer._replace(shot);
        this._emptyView = this._thumbnailView._shotCount() == 0;
        if (this._emptyView) {
          this._swapButton.checked = true;
        }
      });
      this._thumbnailView.connect('enter-event', this._stopDrag.bind(this));
      this._thumbnailView.connect('notify::loaded', () => {
        if (!this._skipFirst) {
          this._skipFirst = true;
          return;
        }

        lg('[UIMainViewer::_init::_thumbnailView::notify::loaded]');
        this._toggleSwap(this._swapButton);
      });

      this._splitViewXContainer.add_child(this._bigViewContainer);
      this._splitViewXContainer.add_child(this._swapViewContainer);
      this._swapViewContainer.add_child(this._thumbnailView);
      this._swapViewContainer.add_child(this._folderView);

      this._animatedIcon = new Animator.Animation(
        Gio.File.new_for_path(`${Me.path}/icons/pixzzle-ui-melt-sprite.png`),
        FRAME_SIZE,
        FRAME_SIZE,
        FRAME_RATE
      );

      this._meltButton = new UIButton({
        style_class: 'pixzzle-ui-melt-button',
        child: this._animatedIcon,
        x_expand: false,
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        visible: !this._isFlattened.get_value(),
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        x: 0,
        y: 0
      });
      this.add_child(this._meltButton);

      this._meltButton.connect('notify::mapped', () => {
        this._animatedIcon.play();
      });
      this._meltButton.connect('clicked', () => {
        this._isFlattened.set_value(true);
      });
      this._isFlattened.connect('notify::changed', (me) => {
        if (me.get_value()) {
          this._folderView.flatten();
        }
        this._animateFlatten(me.get_value());
      });

      this._imageViewer = new UIImageRenderer(this);
      this._imageViewer.connect('lock-axis', (_, axis) => {
        if (this._viewMode !== ViewMode.ADAPTIVE) {
          return;
        }

        let xGap = axis.X_AXIS;
        let yGap = axis.Y_AXIS;
        /*
         * If a new image has been loaded into the big view
         * and it has a smaller size than the previous one,
         * reset our size to default.
         * If our old image has a bigger size than the new
         * one, we shouldn't go back to the default size,
         * we should move back just the enough distance
         * the full image.
         */
        if (xGap < 0) {
          if (this._lastX - (this._startX - xGap) + 1 >= INITIAL_WIDTH) {
            this._startX += -xGap;
          } else {
            this._startX = this._lastX + 1 - INITIAL_WIDTH;
          }
          xGap = 0;
        }

        if (yGap < 0) {
          if (this._lastY - (this._startY - yGap) + 1 >= INITIAL_HEIGHT) {
            this._startY += -yGap;
          } else {
            this._startY = this._lastY + 1 - INITIAL_HEIGHT;
          }
          yGap = 0;
        }
        this._updateSize();

        this._maxXSwing = Math.min(
          this.width + xGap,
          this._activeMonitor.width
        );
        this._maxYSwing = Math.min(
          this.height + yGap,
          this._activeMonitor.height
        );
      });
      this._imageViewer.connect('clean-slate', () => {
        this._maxXSwing = INITIAL_WIDTH;
        this._maxYSwing = INITIAL_HEIGHT;
        const xOffset = this.width - INITIAL_WIDTH;
        const yOffset = this.height - INITIAL_HEIGHT;
        if (xOffset > 0) this._startX += xOffset;
        if (yOffset > 0) this._startY += yOffset;

        this._viewMode = ViewMode.ADAPTIVE;
        this._updateSize();
        this._emptyView = true;
      });
      this._imageViewer.connect('enter-event', this._stopDrag.bind(this));
      this._imageViewer.connect('switch-active', (widget, detail) => {
        lg('[UIMainViewer::_init::_imageViewer::switch-active]');
        this._thumbnailView._switchActive(detail);
      });
      this._bigViewContainer.add_child(this._imageViewer);

      this._snapIndicator = new St.Widget({
        style_class: 'pixzzle-ui-snap-indicator',
        visible: true,
        y_expand: true,
        x_expand: true
      });
      Main.layoutManager.addChrome(this._snapIndicator);

      this._loadSettings();
      this.connect('notify::mapped', () => {
        if (!this.visible) {
          this._thumbnailView.cancelSubscriptions();
          return;
        }
        this._animateSettings();

        // Run only once for the lifetime of the
        // application
        if (!this._viewInitialized) {
          this._folderView.flatten();
          this._viewInitialized = true;
        } else {
          this._thumbnailView.activateSubscriptions();
        }
      });

      this.connect('destroy', this._onDestroy.bind(this));
      this._reload_theme();
    }

    _updateSnapIndicator(x, y, w, h) {
      if (!this._adaptiveGeometry || this._viewMode === ViewMode.ADAPTIVE) {
        this._adaptiveGeometry = [
          this._startX,
          this._startY,
          this._lastX,
          this._lastY
        ];
      }

      if (x === 0 && y === 0 && w === 0 && h === 0) {
        this._snapIndicator.hide();
      } else {
        this._snapIndicator.set_position(x, y);
        this._snapIndicator.set_size(w, h);
        this._snapIndicator.show();
      }
    }

    _updateSizeFromIndicator() {
      if (this._tilingDisabled) {
        return;
      }
      let updateView = false;
      if (this._snapIndicator.visible) {
        this._startX = this._snapIndicator.x;
        this._lastX = this._snapIndicator.x + this._snapIndicator.width - 1;
        this._startY = this._snapIndicator.y;
        this._lastY = this._snapIndicator.y + this._snapIndicator.height - 1;
        this._viewMode = ViewMode.TILE;
        updateView = true;
      } else if (
        this._adaptiveGeometry &&
        this._viewMode === ViewMode.TILE &&
        this._startX > EDGE_THRESHOLD &&
        this._startY > EDGE_THRESHOLD &&
        this._activeMonitor.width - this._lastX > EDGE_THRESHOLD
      ) {
        [this._startX, this._startY, this._lastX, this._lastY] =
          this._adaptiveGeometry;
        this._viewMode = ViewMode.ADAPTIVE;
        this._adaptiveGeometry = null;
        updateView = true;
      }

      if (updateView) {
        this._updateSize();
        this._imageViewer._redraw(0, 0);
      }
      this._snapIndicator.hide();
    }

    get border_width() {
      if (!this._border_width) {
        this._border_width = this.get_theme_node().get_length('border-width');
      }

      return this._border_width;
    }

    _openSnipToolkit() {
      this._imageViewer._openSnipToolkit();
    }

    _computeBigViewSize() {
      const width =
        this.width -
        this.border_width * 2 -
        this._thumbnailView.width -
        this._splitViewXContainer.spacing;
      /*
       * FIXME: For the height, the BoxLayout `SplitViewXContainer`
       * forces the this.border-bottom off. I'll use this workaround
       * of multiplying border-width by 2 to account for the
       * pushed off bottom border, till I find a fix.
       */
      const height =
        this.height -
        this.border_width * 2 -
        this._splitViewXContainer.spacing -
        this._topMostContainer.bottom_padding -
        this._topMostContainer.spacing;

      return [width, height];
    }

    _showScreenshotView() {
      if (!this._shutter) {
        this._shutter = new UIShutter();
        this._shutterClosingHandler = this._shutter.connect(
          'begin-close',
          () => {
            lg('[UIMainViewer::_showScreenshotView::begin-close]');
            this._showUI();
          }
        );
        this._shutterNewShotHandler = this._shutter.connect(
          'new-shot',
          (_, shot) => {
            this._folderView.addNewShot(shot).catch(logError);
          }
        );
      }

      this._close();
      this.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._shutter._showUI();
        }
      });
    }

    _moveFloatingButton(index) {
      /*
       * Use `AlignConstraint` with factor
       * set to `1` to position the button
       * in the bottom-right corner. This
       * is how to simulate fixed
       * positioning. The `x` and `y`
       * property of the button shifts
       * it to the desired position.
       */
      const meltButtonInfo = [
        {
          /*
           * Play with the values a bit to get a good
           * initial position
           */
          x: -55,
          y: -80,
          constraints: [
            new Clutter.AlignConstraint({
              source: this,
              align_axis: Clutter.AlignAxis.X_AXIS,
              pivot_point: new Graphene.Point({ x: 0.5, y: 0 }),
              factor: 1
            }),

            new Clutter.AlignConstraint({
              source: this,
              align_axis: Clutter.AlignAxis.Y_AXIS,
              pivot_point: new Graphene.Point({ x: 0, y: 1 }),
              factor: 1
            })
          ]
        },
        {
          x: 20,
          y: -80,
          constraints: [
            new Clutter.AlignConstraint({
              source: this,
              align_axis: Clutter.AlignAxis.X_AXIS,
              pivot_point: new Graphene.Point({ x: 0, y: 0 }),
              factor: 0
            }),

            new Clutter.AlignConstraint({
              source: this,
              align_axis: Clutter.AlignAxis.Y_AXIS,
              pivot_point: new Graphene.Point({ x: 0, y: 1 }),
              factor: 1
            })
          ]
        }
      ];
      const match = meltButtonInfo[index];
      this._meltButton.clear_constraints();
      this._meltButton.set_position(match.x, match.y);
      for (const constraint of match.constraints) {
        this._meltButton.add_constraint(constraint);
      }
    }

    _animateFlatten(state) {
      if (state) {
        this._meltButton.ease({
          scale_x: 0,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._meltButton.ease({
          scale_y: 0,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => {
            this._meltButton.hide();
            this._animatedIcon.stop();
          }
        });
      } else {
        this._meltButton.show();
        this._animatedIcon.play();
        this._meltButton.ease({
          scale_x: 1,
          duration: 400,
          mode: Clutter.AnimationMode.EASE_IN_OUT_ELASTIC
        });
        this._meltButton.ease({
          scale_y: 1,
          duration: 400,
          mode: Clutter.AnimationMode.EASE_IN_OUT_ELASTIC
        });
      }
    }

    _toggleSwap(widget) {
      const correction = this._heightDiff ? this._heightDiff : 0;
      const extent = this._swapViewContainer.height - correction;
      lg('[UIMainViewer::_init::_swapButton::notify::checked]', extent);
      this._animateSwap();
      // folder hidden
      if (widget.checked) {
        this._crossSlideAnimate(
          this._folderView,
          this._thumbnailView,
          extent,
          correction
        );
      } else {
        this._crossSlideAnimate(
          this._thumbnailView,
          this._folderView,
          extent,
          correction
        );
      }

      if (!this._meltButton.visible) {
        this._isFlattened.set_value(false);
      }

      /*
       * When the MainViewer becomes visible,
       * we show a list of all the shots
       * taken. In this view mode, no `date`
       * has been selected. We use this
       * `_groupingEnabled` to determine if
       * we are in this mode. We should
       * keep hiding the melt button if
       * we are back in this view mode.
       */
      if (!this._groupingEnabled) {
        this._animateFlatten(!this._swapButton.checked);
      }
    }

    _crossSlideAnimate(one, other, extent, correction) {
      /*
       * Changing the height of an actor also
       * changes its minimum height. If we intend
       * to have a smooth crossFade animation,
       * we have to adjust the minimum height of the
       * actor and also synchronize their height
       * adjustment.
       * @param correction adjusts the height of
       * the enlarged actor if its parent container
       * has shrinked than the size it is currently
       * at.
       */
      one.visible = true;
      one.height = 0;
      one.ease({
        height: extent,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_IN_OUT,
        onComplete: () => {
          one.min_height = 0;
        }
      });
      other.height -= correction;
      other.ease({
        height: 0,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_IN_OUT,
        onComplete: () => {
          other.visible = false;
          other.min_height = 0;
        }
      });
    }

    _animateSwap() {
      const ROTATION_ANGLE = -90;
      const extent =
        this._swapIcon.rotation_angle_z === ROTATION_ANGLE ? 0 : ROTATION_ANGLE;
      this._swapIcon.ease({
        rotation_angle_z: extent,
        duration: 200,
        mode: Clutter.AnimationMode.LINEAR
      });
    }

    _animateSettings() {
      const ROTATION_ANGLE = 270;
      const extent =
        this._settingsButton.rotation_angle_z < ROTATION_ANGLE
          ? ROTATION_ANGLE
          : -ROTATION_ANGLE;
      this._settingsButton.ease({
        rotation_angle_z: extent,
        duration: 800,
        mode: Clutter.AnimationMode.LINEAR
      });
    }

    _openSettings() {
      if (this._settingsWindow()) {
        this._closeSettings();
        return;
      }

      ExtensionUtils.openPrefs();
    }

    _settingsWindow() {
      const windows = global.display.list_all_windows();
      const appName = Me.metadata.name;
      const settingsWindow = windows.find((win) => win.title === appName);
      return settingsWindow;
    }

    _closeSettings() {
      this._settingsWindow()?.kill();
      this._settingsOpen = false;
    }

    _loadSettings() {
      this._settings = inflateSettings();
      this._shortcutsBindingIds = [];
      this._settingsChangedId = this._settings.connect(
        'changed',
        this._onSettingsChange.bind(this)
      );
      this._updateSettings();
      this._bindShortcuts();
    }

    _onSettingsChange() {
      this._updateSettings();
      this._bindShortcuts();
      lg('[UIMainViewer::_onSettingsChange]');
    }

    _updateSettings() {
      const mainBGColor = getColorSetting(
        Prefs.Fields.MAIN_BG_COLOR,
        this._settings
      );
      const thumbnailBGColor = getColorSetting(
        Prefs.Fields.THUMBNAIL_BG_COLOR,
        this._settings
      );
      const screenshotButtonBGColor = getColorSetting(
        Prefs.Fields.SHOTBUTTON_BG_COLOR,
        this._settings
      );
      const screenshotButtonFGColor = getColorSetting(
        Prefs.Fields.SHOTBUTTON_FG_COLOR,
        this._settings
      );

      setBGColor(this, mainBGColor);
      setBGColor(this._thumbnailView, thumbnailBGColor);
      setBGColor(this._screenshotButton, screenshotButtonBGColor);
      setFGColor(this._screenshotButton, screenshotButtonFGColor);

      const viewIndex = this._settings.get_int(Prefs.Fields.SWAP_VIEWS);
      const views = [this._bigViewContainer.name, this._thumbnailView.name];
      const firstChild = this._splitViewXContainer.get_first_child();
      const firstChildIndex = views.findIndex((v) => v == firstChild.name);
      if (firstChildIndex !== viewIndex) {
        this._splitViewXContainer.set_child_above_sibling(
          ...this._splitViewXContainer.get_children()
        );
      }

      this._moveFloatingButton(viewIndex);

      this._tilingDisabled = this._settings.get_boolean(
        Prefs.Fields.DISABLE_TILE_MODE
      );

      this._bindSettings();

      function getColorSetting(id, settings) {
        let colors = settings.get_strv(id);
        const color = colors
          .map((c, i) => (i < 3 ? c * FULLY_OPAQUE : c))
          .join(',');
        return 'rgba(' + color + ')';
      }
      function setBGColor(obj, color) {
        addStyle(obj, 'background-color', color);
      }
      function setFGColor(obj, color) {
        addStyle(obj, 'color', color);
      }
      function addStyle(obj, prop, value) {
        let style = obj.get_style() ?? '';
        if (style.length !== 0) style += ';';
        style += `${prop}: ${value}`;
        style = uniquefy(style);
        obj.set_style(style);
      }

      function uniquefy(pattern) {
        const sections = pattern.split(';');
        const obj = {};
        for (const section of sections) {
          const divider = section.indexOf(':');
          const key = section.slice(0, divider);
          const value = section.slice(divider + 1);
          if (!key || !value) continue;
          Object.assign(obj, { ...obj, [key]: value });
        }

        const unique = Object.entries(obj).reduce(
          (acc, [k, v]) =>
            acc.length === 0 ? k + ':' + v : acc + ';' + k + ':' + v,
          ''
        );

        return unique;
      }
    }

    _bindSettings() {
      SETTING_DISABLE_TILE_MODE = this._settings.get_boolean(
        Prefs.Fields.DISABLE_TILE_MODE
      );
      SETTING_NATURAL_PANNING = this._settings.get_boolean(
        Prefs.Fields.NATURAL_PANNING
      );

      SETTING_OCR_API = this._settings.get_string(Prefs.Fields.OCR_API);
    }

    _bindShortcuts() {
      this._unbindShortcuts();

      this._bindShortcut(
        Prefs.Fields.TOGGLE_VISIBILITY,
        this._toggleUI.bind(this)
      );
      this._bindShortcut(
        Prefs.Fields.OPEN_SHUTTER,
        this._showScreenshotView.bind(this)
      );
    }

    _unbindShortcuts() {
      this._shortcutsBindingIds.forEach((id) => Main.wm.removeKeybinding(id));
      this._shortcutsBindingIds = [];
    }

    _bindShortcut(name, cb) {
      const ModeType = Shell.hasOwnProperty('ActionMode')
        ? Shell.ActionMode
        : Shell.KeyBindingMode;

      const uiModes = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;
      Main.wm.addKeybinding(
        name,
        this._settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        uiModes,
        cb.bind(this)
      );

      this._shortcutsBindingIds.push(name);
    }

    _reload_theme() {
      const theme_context = St.ThemeContext.get_for_stage(global.stage);
      const theme = theme_context.get_theme();
      if (!theme) return;

      let stylesheet = Me.dir.get_child('stylesheet.css');

      theme.unload_stylesheet(stylesheet);
      theme.load_stylesheet(stylesheet);
      theme_context.set_theme(theme);
    }

    _close(instantly = false) {
      this.remove_all_transitions();
      global.display.set_cursor(Meta.Cursor.DEFAULT);
      if (this._dragButton) {
        this._stopDrag();
      }
      this._isActive = false;
      this._closeSettings();
      if (instantly) {
        this.hide();
      } else {
        this.ease({
          opacity: 0,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: this.hide.bind(this)
        });
      }
      this._snapIndicator.hide();
    }

    _onDestroy() {
      if (this._shutter) {
        this._shutter.disconnect(this._shutterClosingHandler);
        this._shutter.disconnect(this._shutterNewShotHandler);
        this._shutter.destroy();
        this._shutter = null;
      }

      if (this._modalWatcher) {
        this._modalWatcher.remove();
        this._modalWatcher = null;
      }

      Main.layoutManager.removeChrome(this._snapIndicator);
      Main.layoutManager.removeChrome(this);
      this._unbindShortcuts();
    }

    _showUI() {
      if (this._isActive) return;

      new Timer(this).add(
        300,
        function () {
          this.opacity = 0;
          this.show();
          this.ease({
            opacity: FULLY_OPAQUE,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
          });

          lg('[UIMainViewer::_showUI]');
          this._isActive = true;
          return GLib.SOURCE_REMOVE;
        }.bind(this),
        'UIMainViewer._showUI'
      );
    }

    _toggleUI() {
      // Don't open if there's a pop-up dialog
      if (Main.modalCount > 0) {
        this._close();
        return;
      }

      const newOpacity = this._isActive ? FULLY_OPAQUE : 0;
      this.opacity = newOpacity;
      if (!this._isActive) {
        this.show();
      } else {
        this._closeSettings();
      }
      this.ease({
        opacity: FULLY_OPAQUE - newOpacity,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._isActive && this.hide();
          this._isActive = !this._isActive;
          lg('[UIMainViewer::_toggleUI]');
        }
      });
    }

    reset() {
      this._stopDrag();
      global.display.set_cursor(Meta.Cursor.DEFAULT);

      // Preserve area selection if possible. If the area goes out of bounds,
      // the monitors might have changed, so reset the area.
      const [x, y, w, h] = this._getGeometry();
      // Initially x < 0 will be true so that we can get
      // set the `_activeMonitor` property.
      if (
        x < 0 ||
        y < 0 ||
        x + w > this?._activeMonitor?.width ||
        y + h > this?._activeMonitor?.height
      ) {
        // Initialize area to out of bounds so if there's no monitor,
        // the area will be reset once a monitor does appear.
        this._startX = -1;
        this._startY = 0;
        this._lastX = 0;
        this._lastY = 0;

        // This can happen when running headless without any monitors.
        if (Main.layoutManager.primaryIndex !== -1) {
          const monitor =
            Main.layoutManager.monitors[Main.layoutManager.primaryIndex];

          /*
           * Set the initial dimension of the selection rect
           */
          this._startX = monitor.x + monitor.width - INITIAL_WIDTH - ALLOWANCE;
          this._startY = monitor.y + (monitor.height - INITIAL_HEIGHT) / 2;
          this._lastX = this._startX + INITIAL_WIDTH;
          this._lastY = this._startY + INITIAL_HEIGHT;

          this._activeMonitor = monitor;
        }
        this._updateSize();
      }
    }

    _getGeometry() {
      const leftX = Math.min(this._startX, this._lastX);
      const topY = Math.min(this._startY, this._lastY);
      const rightX = Math.max(this._startX, this._lastX);
      const bottomY = Math.max(this._startY, this._lastY);

      return [leftX, topY, rightX - leftX + 1, bottomY - topY + 1];
    }

    _updateSize() {
      this._heightDiff = this.height;

      const [x, y, w, h] = this._getGeometry();
      this._setRect(x, y, w, h);

      this._heightDiff -= this.height;
    }

    _setRect(x, y, w, h) {
      this.set_position(x, y);
      this.set_size(w, h);
    }

    _computeCursorType(cursorX, cursorY) {
      const desc = '[UIMainViewer::_computeCursorType]';
      const [leftX, topY, width, height] = this._getGeometry();
      const [rightX, bottomY] = [leftX + width - 1, topY + height - 1];
      const [x, y] = [cursorX, cursorY];

      const node = this.get_theme_node();
      const threshold =
        10 * St.ThemeContext.get_for_stage(global.stage).scaleFactor;

      const iconSize = this._closeButton.width;
      if ((x - rightX) ** 2 + (y - topY) ** 2 <= iconSize ** 2) {
        return Meta.Cursor.DEFAULT;
      }

      if (x - leftX >= 0 && x - leftX <= threshold) {
        if (y - topY >= 0 && y - topY <= threshold) {
          lg(desc, 'NORTH_WEST');
          return Meta.Cursor.NW_RESIZE;
        } else if (bottomY - y >= 0 && bottomY - y <= threshold) {
          lg(desc, 'SOUTH_WEST');
          return Meta.Cursor.SW_RESIZE;
        } else if (y - topY > 0 && bottomY - y > 0) {
          lg(desc, 'WEST');
          return Meta.Cursor.WEST_RESIZE;
        }
      } else if (y - topY >= 0 && y - topY <= threshold) {
        if (rightX - x >= 0 && rightX - x <= threshold) {
          lg(desc, 'NORTH_EAST');
          return Meta.Cursor.NE_RESIZE;
        } else if (x - leftX > 0 && rightX - x > 0) {
          lg(desc, 'NORTH');
          return Meta.Cursor.NORTH_RESIZE;
        }
      } else if (rightX - x >= 0 && rightX - x <= threshold) {
        if (bottomY - y >= 0 && bottomY - y <= threshold) {
          lg(desc, 'SOUTH_EAST');
          return Meta.Cursor.SE_RESIZE;
        } else if (y - topY > 0 && bottomY - y > 0) {
          lg(desc, 'EAST');
          return Meta.Cursor.EAST_RESIZE;
        }
      } else if (bottomY - y >= 0 && bottomY - y <= threshold) {
        if (x - leftX > 0 && rightX - x > 0) {
          lg(desc, 'SOUTH');
          return Meta.Cursor.SOUTH_RESIZE;
        }
      } else if (x - leftX > 0 && rightX - x > 0) {
        if (y - topY > 0 && bottomY - y > 0) {
          lg(desc, 'MOVE_OR_RESIZE');
          return Meta.Cursor.MOVE_OR_RESIZE_WINDOW;
        }
      }

      lg('[UIMainViewer::_computeCursorType]', 'Setting cursor to DEFAULT');

      return Meta.Cursor.DEFAULT;
    }

    _stopDrag() {
      if (!this._dragButton) return;

      this._dragButton = 0;
      this._dragGrab?.dismiss();
      this._dragGrab = null;
      this._dragSequence = null;

      this.emit('drag-ended');
    }

    _updateCursor(x, y) {
      const cursor = this._computeCursorType(x, y);
      lg('[UIMainViewer::_updateCursor]', cursor);
      global.display.set_cursor(cursor);
    }

    _onPress(event, button, sequence) {
      if (this._dragButton) {
        return Clutter.EVENT_PROPAGATE;
      }

      this._dragButton = button;
      this._dragGrab = global.stage.grab(this);
      this._dragCursor = this._computeCursorType(event.x, event.y);
      [this._dragX, this._dragY] = [event.x, event.y];
      this.emit('drag-started');

      return Clutter.EVENT_STOP;
    }

    _onRelease(event, button, sequence) {
      if (
        this._dragButton !== button ||
        this._dragSequence?.get_slot() !== sequence?.get_slot()
      )
        return Clutter.EVENT_PROPAGATE;

      lg('[UIMainViewer::_onRelease]');
      this._stopDrag();

      const [x, y] = [event.x, event.y];
      this._updateCursor(x, y);
      this._updateSizeFromIndicator();

      return Clutter.EVENT_STOP;
    }

    _onMotion(event, sequence) {
      const [x, y] = [event.x, event.y];
      if (!this._dragButton) {
        this._updateCursor(x, y);
        return Clutter.EVENT_PROPAGATE;
      }

      let dx = Math.round(x - this._dragX);
      let dy = Math.round(y - this._dragY);
      let overshootX, overshootY;
      const cursor = this._dragCursor;
      const [monitorWidth, monitorHeight] = [
        this._activeMonitor.width,
        this._activeMonitor.height
      ];

      const [leftX, topY, rightX, bottomY] = [
        this._startX,
        this._startY,
        this._lastX,
        this._lastY
      ];

      if (cursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
        this._startX += dx;
        this._startY += dy;
        this._lastX += dx;
        this._lastY += dy;
      } else {
        if (
          cursor === Meta.Cursor.NORTH_RESIZE ||
          cursor === Meta.Cursor.SOUTH_RESIZE
        )
          dx = 0;
        if (
          cursor === Meta.Cursor.WEST_RESIZE ||
          cursor === Meta.Cursor.EAST_RESIZE
        )
          dy = 0;

        if (
          cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.SW_RESIZE ||
          cursor === Meta.Cursor.WEST_RESIZE
        ) {
          this._startX += dx;
        }

        if (
          cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.NE_RESIZE ||
          cursor === Meta.Cursor.NORTH_RESIZE
        ) {
          this._startY += dy;
        }

        if (
          cursor === Meta.Cursor.SE_RESIZE ||
          cursor === Meta.Cursor.NE_RESIZE ||
          cursor === Meta.Cursor.EAST_RESIZE
        ) {
          this._lastX += dx;
        }

        if (
          cursor === Meta.Cursor.SW_RESIZE ||
          cursor === Meta.Cursor.SE_RESIZE ||
          cursor === Meta.Cursor.SOUTH_RESIZE
        ) {
          this._lastY += dy;
        }
      }

      /*
       * Use flag to selectively remove points
       * that was updated above. During a move,
       * we update all the 4 endpoints. When
       * we reach the boundaries of the window,
       * we have to remove the update from both
       * ends that have the update added. If
       * this is not done, the end at the
       * boundary stays at the boundary, the
       * opposite end expands.
       */
      const isMove = cursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW;
      if (this._startX < Panel.Left.width - this.width / 2) {
        overshootX = Panel.Left.width - this.width / 2 - this._startX;
        this._startX += overshootX;
        this._lastX += overshootX * isMove;
        dx -= overshootX;
      } else if (
        this._lastX >=
        monitorWidth - Panel.Right.width + this.width / 2
      ) {
        overshootX =
          monitorWidth - Panel.Right.width + this.width / 2 - this._lastX;
        this._startX += overshootX * isMove;
        this._lastX += overshootX;
        dx -= overshootX;
      }

      if (this._startY < Panel.Top.height) {
        overshootY = Panel.Top.height - this._startY;
        this._startY += overshootY;
        this._lastY += overshootY * isMove;
        dy -= overshootY;
      } else if (
        this._lastY >=
        monitorHeight - Panel.Bottom.height + this.height / 2
      ) {
        overshootY =
          monitorHeight - Panel.Bottom.height + this.height / 2 - this._lastY;
        this._startY += overshootY * isMove;
        this._lastY += overshootY;
        dy -= overshootY;
      }

      if (cursor !== Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
        const isTileMode = this._viewMode === ViewMode.TILE;
        const [x, y, w, h] = this._getGeometry();
        const [minWidth, minHeight, maxWidth, maxHeight] = [
          INITIAL_WIDTH,
          INITIAL_HEIGHT,
          isTileMode ? monitorWidth : this._maxXSwing ?? this.width,
          isTileMode ? monitorHeight : this._maxYSwing ?? this.height
        ];

        if (w < minWidth) {
          const overshootX = w - minWidth;
          if (leftX < x) {
            this._startX += overshootX;
            dx -= overshootX;
          } else if (x + w - 1 < rightX) {
            this._lastX -= overshootX;
            dx += overshootX;
          }
        } else if (w > maxWidth) {
          const overshootX = w - maxWidth;
          if (x < leftX) {
            this._startX += overshootX;
            dx -= overshootX;
          } else if (x + w - 1 > rightX) {
            this._lastX -= overshootX;
            dx += overshootX;
          }
        }
        if (h < minHeight) {
          const overshootY = h - minHeight;
          if (topY < y) {
            this._startY += overshootY;
            dy -= overshootY;
          } else if (y + h - 1 < bottomY) {
            this._lastY -= overshootY;
            dy += overshootY;
          }
        } else if (h > maxHeight) {
          const overshootY = h - maxHeight;
          if (y < topY) {
            this._startY += overshootY;
            dy -= overshootY;
          } else if (y + h - 1 > bottomY) {
            this._lastY -= overshootY;
            dy += overshootY;
          }
        }
      } else if (
        cursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW &&
        !this._emptyView &&
        !this._tilingDisabled
      ) {
        const leftTorque = monitorWidth / 2 - x;
        const rightTorque = x - monitorWidth / 2;
        const isEquallyLikely =
          this._lastX <= monitorWidth - Panel.Right.width &&
          monitorWidth - this._lastX <= EDGE_THRESHOLD + Panel.Right.width;
        if (
          this._startX >= Panel.Left.width &&
          this._startX <= EDGE_THRESHOLD + Panel.Left.width &&
          ((isEquallyLikely && leftTorque > rightTorque) || !isEquallyLikely)
        ) {
          this._updateSnapIndicator(
            0 + Panel.Left.width,
            0 + Panel.Top.height,
            monitorWidth / 2 - Panel.Left.width,
            monitorHeight - Panel.Top.height - Panel.Bottom.height
          );
        } else if (isEquallyLikely) {
          this._updateSnapIndicator(
            monitorWidth / 2,
            0 + Panel.Top.height,
            monitorWidth / 2 - Panel.Right.width,
            monitorHeight - Panel.Top.height - Panel.Bottom.height
          );
        } else if (
          this._startY >= Panel.Top.height &&
          this._startY <= EDGE_THRESHOLD + Panel.Top.height
        ) {
          this._updateSnapIndicator(
            0 + Panel.Left.width,
            0 + Panel.Top.height,
            monitorWidth - Panel.Left.width - Panel.Right.width,
            monitorHeight - Panel.Top.height - Panel.Bottom.height
          );
        } else {
          this._updateSnapIndicator(0, 0, 0, 0);
        }
      }

      this._updateSize();
      if (this._dragCursor !== Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
        this._imageViewer._redraw(dx, dy);
      }

      this._dragX += dx;
      this._dragY += dy;
      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_key_press_event(event) {
      const symbol = event.keyval;
      lg('[UIMainViewer::vfunc_key_press_event]', 'symbol:', symbol);
      if (symbol === Clutter.KEY_Down) {
        if (this._swapButton.checked) {
          this._swapButton.checked = false;
        }
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Up) {
        if (!this._swapButton.checked) {
          this._swapButton.checked = true;
        }
        return Clutter.EVENT_STOP;
      }
      this._imageViewer._onKeyPress(event);

      return super.vfunc_key_press_event(event);
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onPress(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onRelease(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

    /*vfunc_touch_event(event) {
    const eventType = event.type;
    if (eventType === Clutter.EventType.TOUCH_BEGIN)
      return this._onPress(event, 'touch', event.get_event_sequence());
    else if (eventType === Clutter.EventType.TOUCH_END)
      return this._onRelease(event, 'touch', event.get_event_sequence());
    else if (eventType === Clutter.EventType.TOUCH_UPDATE)
      return this._onMotion(event, event.get_event_sequence());

    return Clutter.EVENT_PROPAGATE;
   } */

    vfunc_leave_event(event) {
      lg('[UIMainViewer::vfunc_leave_event]');
      global.stage.set_key_focus(null);
      this._updateSizeFromIndicator();
      if (this._dragButton) {
        return this._onMotion(event, null);
      } else {
        this._dragButton = 0;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
      }

      return super.vfunc_leave_event(event);
    }

    vfunc_enter_event(event) {
      lg('[UIMainViewer::vfunc_enter_event]');
      this.grab_key_focus();
      return super.vfunc_enter_event(event);
    }
  }
);

const ViewOrientation = Object.freeze({ TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3 });
const Directivity = Object.freeze({ NEXT: 1, PREV: -1 });
const N_AXIS = 4;

const UIImageRenderer = GObject.registerClass(
  {
    Signals: {
      'lock-axis': { param_types: [Object.prototype] },
      'clean-slate': {},
      'ocr-cancelled': {},
      'switch-active': { param_types: [Object.prototype] }
    }
  },
  class UIImageRenderer extends St.Widget {
    _init(topParent, params) {
      super._init({
        ...params,
        reactive: true,
        can_focus: true,
        layout_manager: new Clutter.BinLayout()
      });

      this._topParent = topParent;
      this._canvas = new Clutter.Canvas();
      this.set_content(this._canvas);
      this._xpos = 0;
      this._ypos = 0;
      this._orientationLU = new Array(N_AXIS);
      this._orientation = ViewOrientation.TOP;
      this._canvas.connect('draw', (canvas, context) => {
        if (this._pixbuf && this._filename) {
          const [pixWidth, pixHeight] = [
            this._pixbuf.get_width(),
            this._pixbuf.get_height()
          ];

          const [maxWidth, maxHeight] = this._topParent._computeBigViewSize();
          const [effectiveWidth, effectiveHeight] = [
            Math.min(pixWidth - this._xpos, maxWidth),
            Math.min(pixHeight - this._ypos, maxHeight)
          ];
          const pixbuf = this._pixbuf.new_subpixbuf(
            this._xpos,
            this._ypos,
            effectiveWidth,
            effectiveHeight
          );
          if (pixbuf === null) {
            lg('[UIImageRenderer::_init::_draw]', 'pixbuf = (null)');
            return;
          }
          this._visibleRegionPixbuf = pixbuf;

          context.save();
          context.setOperator(Cairo.Operator.CLEAR);
          context.paint();
          context.restore();
          cairo_set_source_pixbuf(
            context,
            pixbuf,
            (maxWidth - effectiveWidth) / 2,
            (maxHeight - effectiveHeight) / 2
          );
          context.paint();

          /*
           * For a new screenshot, this._ocrScanOnEntry
           * flag indicates that we want to perform
           * ocr scan immediately we screenshot the
           * image.
           */
          if (this._ocrScanOnEntry) {
            this._ocrScanOnEntry = false;
            this._openSnipToolkit();
            this._snipIndicator.x = (maxWidth - pixbuf.width) / 2;
            this._snipIndicator.y = (maxHeight - pixbuf.height) / 2;
            this._snipIndicator.width = this._pixbuf.width;
            this._snipIndicator.height = this._pixbuf.height;
            this._doOCR(this._pixbuf);
          }
        } else if (this._filename) {
          context.save();
          context.setOperator(Cairo.Operator.CLEAR);
          context.paint();
          this._filename = null;
        }
      });
      this._snipIndicator = new St.Widget({
        style_class: 'pixzzle-ui-ocr-indicator'
      });
      this.add_child(this._snipIndicator);

      this._ocrText = new UIOcrTip(this._snipIndicator, this, {
        style_class: 'pixzzle-ui-ocrtip',
        x_align: St.Align.START,
        visible: false,
        reactive: true
      });
      this._ocrText.clutter_text.set_editable(false);
      this._ocrText.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      this._topParent.add_child(this._ocrText);

      this._snipActions = {
        [Clutter.KEY_o]: this._doOCR.bind(this),
        [Clutter.KEY_O]: this._doOCR.bind(this),
        [Clutter.KEY_c]: this._doCopyImage.bind(this),
        [Clutter.KEY_C]: this._doCopyImage.bind(this)
      };
      this._snipTrigger = null;
    }

    _redraw(deltaX, deltaY) {
      if (this._filename) {
        const [width, height] = this._topParent._computeBigViewSize();
        this._render(deltaX, deltaY, width, height);
      } else {
        this._isPanningEnabled = false;
        this._closeSnipToolkit();
      }
    }

    _replace(shot) {
      const newFile = shot.name;
      this._shotWidget = shot.widget;
      this._ocrScanOnEntry = shot.ocr;
      lg(
        '[UIImageRenderer::_replace]',
        'newFile:',
        newFile,
        'next shot:',
        this._shotWidget
      );
      if (newFile === null) {
        this._unload();
        this.set_size(0, 0);
        this._reOrient(-this._orientation, true /* flush */);
        this.emit('clean-slate');
        this._isPanningEnabled = false;
      } else if (newFile !== this._filename) {
        /*
         * Since we support rotation, create
         * a pixel buffer with a size of the
         * maximum dimension that can be achieved
         * through rotation. Any time we want
         * to render, we will rotate the mouse
         * to the current angle.
         */
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(newFile);
        if (pixbuf != null) {
          this._abortSnipSession();
          this._reOrient(-this._orientation, true /* flush */);
          this._pixbuf = pixbuf;
          this._filename = newFile;
          this._reload();
        }
      }
    }

    _unload() {
      this._pixbuf = null;
      this._canvas.invalidate();
    }

    _reload() {
      const [width, height] = this._topParent._computeBigViewSize();
      const [pixWidth, pixHeight] = [
        this._pixbuf.get_width(),
        this._pixbuf.get_height()
      ];

      this.emit('lock-axis', {
        X_AXIS: pixWidth - width,
        Y_AXIS: pixHeight - height
      });
      this._redraw(0, 0);
    }

    _render(deltaX, deltaY, maxWidth, maxHeight) {
      const [pixWidth, pixHeight] = [
        this._pixbuf.get_width(),
        this._pixbuf.get_height()
      ];
      this._isPanningEnabled = pixWidth > maxWidth || pixHeight > maxHeight;
      this._updateToolkits();
      const lockedAxis = {
        X_AXIS: pixWidth <= maxWidth,
        Y_AXIS: pixHeight <= maxHeight
      };
      if (!this._isPanningEnabled) {
        this._xpos = this._ypos = 0;
      } else {
        /*
         * If the panning area is not yet
         * at the edge, move the area
         * to fill up the space created
         * from the drag.
         * Clip the drag delta that is added
         * so that we don't exceed the
         * maximum size of the image.
         */
        if (!lockedAxis.X_AXIS && this._xpos + maxWidth >= pixWidth) {
          this._xpos += Math.max(
            -Math.abs(deltaX),
            pixWidth - this._xpos - maxWidth
          );
        }

        if (!lockedAxis.Y_AXIS && this._ypos + maxHeight >= pixHeight) {
          this._ypos += Math.max(
            -Math.abs(deltaY),
            pixHeight - this._ypos - maxHeight
          );
        }
      }

      this._canvas.invalidate();
      this._canvas.set_size(maxWidth, maxHeight);
      this.set_size(maxWidth, maxHeight);
    }

    /*
     * Keep track of panning state at the current
     * orientation and restore on the next rotation.
     */
    _reOrient(by, flush) {
      if (flush) {
        this._orientationLU.fill(null);
      } else {
        this._orientationLU[this._orientation] = {
          x: this._xpos,
          y: this._ypos
        };
      }

      const next = (this._orientation + by) % N_AXIS;
      this._orientation = next;
      const pos = this._orientationLU[next];

      this._xpos = pos?.x ?? 0;
      this._ypos = pos?.y ?? 0;
    }

    _copyTextToClipboard(text, message) {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

      // Show a notification.
      const source = new MessageTray.Source(
        _('Pixzzle'),
        'screenshot-recorded-symbolic'
      );
      const notification = new MessageTray.Notification(
        source,
        _(`${message}`),
        _('Text is available in your clipboard'),
        {}
      );
      notification.setTransient(true);
      Main.messageTray.add(source);
      source.showNotification(notification);
    }

    _copyImageToClipboard(pixbuf, message) {
      if (this._clipboardCopyCancellable) {
        this._clipboardCopyCancellable.cancel();
      }

      this._clipboardCopyCancellable = new Gio.Cancellable();
      const stream = Gio.MemoryOutputStream.new_resizable();
      pixbuf.save_to_streamv_async(
        stream,
        'png',
        [],
        [],
        this._clipboardCopyCancellable,
        (pixbuf, task) => {
          if (!GdkPixbuf.Pixbuf.save_to_stream_finish(task)) {
            return;
          }
          stream.close(null);
          const clipboard = St.Clipboard.get_default();
          const bytes = stream.steal_as_bytes();
          clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
          lg('[UIImageRenderer::_copyToClipboard]');

          const time = GLib.DateTime.new_now_local();
          const pixels = pixbuf.read_pixel_bytes();
          const content = St.ImageContent.new_with_preferred_size(
            pixbuf.width,
            pixbuf.height
          );
          content.set_bytes(
            pixels,
            Cogl.PixelFormat.RGBA_8888,
            pixbuf.width,
            pixbuf.height,
            pixbuf.rowstride
          );

          // Show a notification.
          const source = new MessageTray.Source(
            _('Pixzzle'),
            'screenshot-recorded-symbolic'
          );
          const notification = new MessageTray.Notification(
            source,
            _(`${message}`),
            _('You can paste the image from the clipboard.'),
            { datetime: time, gicon: content }
          );
          notification.setTransient(true);
          Main.messageTray.add(source);
          source.showNotification(notification);
        }
      );
    }

    _updateToolkits() {
      this._closeSnipToolkit();
    }

    _closeSnipToolkit() {
      this._isInSnipSession = false;
      this._snipIndicator.hide();
      this._ocrText.close();
    }

    _openSnipToolkit() {
      if (this._isPanningEnabled) {
        this._isPanningEnabled = !this._isPanningEnabled;
      }

      // Perform ocr
      lg('[UIImageRenderer::_onKeyPress]', 'setting up snip');
      this._isInSnipSession = !this._isInSnipSession;
      if (this._isInSnipSession) {
        this._snipIndicator.show();
      } else {
        this._snipIndicator.hide();
        this._ocrText.close();
      }
      this._snipIndicator.set_size(0, 0);
      this._updateCursor();
    }

    _processSnipCapture() {
      const vw = this._visibleRegionPixbuf.width;
      const vh = this._visibleRegionPixbuf.height;
      const w = this._canvas.width;
      const h = this._canvas.height;
      const oLeft = this._snipIndicator.x;
      const oTop = this._snipIndicator.y;
      const oRight = oLeft + this._snipIndicator.width - 1;
      const oBottom = oTop + this._snipIndicator.height - 1;
      const [minX, minY] = [(w - vw) / 2, (h - vh) / 2];
      const [maxX, maxY] = [(w + vw) / 2, (h + vh) / 2];
      let [startX, startY] = [minX, minY];
      let [endX, endY] = [maxX, maxY];

      if (oLeft >= startX) {
        startX = oLeft;
      }
      if (oTop >= startY) {
        startY = oTop;
      }
      if (oRight <= endX) {
        endX = oRight;
      }
      if (oBottom <= endY) {
        endY = oBottom;
      }

      if (
        startX >= minX &&
        startX <= maxX &&
        startY >= minY &&
        startY <= maxY &&
        endX >= startX &&
        endX <= maxX &&
        endY >= startY &&
        endY <= maxY
      ) {
        const width = endX - startX + 1;
        const height = endY - startY + 1;
        if (width < 10 || height < 10) {
          lg('[UIImageRenderer::_processSnipCapture]', width, height);
          this._snipIndicator.set_size(0, 0);
          return;
        }

        this._snipIndicator.set_position(startX, startY);
        this._snipIndicator.set_size(width, height);

        startX -= minX;
        startY -= minY;
        endX -= minX;
        endY -= minY;

        const pixbuf = this._visibleRegionPixbuf.new_subpixbuf(
          Math.max(startX, 0),
          Math.max(startY, 0),
          // Do this to ensure that we don't exceed the size limit of
          // the image.
          Math.min(endX - startX + 1, vw - startX),
          Math.min(endY - startY + 1, vh - startY)
        );
        if (pixbuf === null) {
          lg('[UIImageRenderer::_processSnipCapture]', 'pixbuf == (null)');
          return;
        }
        this._snipActions[this._snipTrigger]?.(pixbuf);
      } else {
        this._snipIndicator.set_size(0, 0);
      }
    }

    _doOCR(pixbuf) {
      if (this._ocrCancellable) {
        this._ocrCancellable.cancel();
        this._ocrCancellable = null;
        this._ocrResultAvailable = false;
      }

      this._ocrText.open(_('Loading...'), true /* instantly */);

      this._session = new Soup.Session({ ssl_strict: false });
      const stream = Gio.MemoryOutputStream.new_resizable();

      this._ocrCancellable = new Gio.Cancellable();
      pixbuf.save_to_streamv_async(
        stream,
        'png',
        [],
        [],
        this._ocrCancellable,
        function (pixbuf, task) {
          if (this._ocrCancellable.is_cancelled()) {
            return;
          }
          if (!GdkPixbuf.Pixbuf.save_to_stream_finish(task)) {
            return;
          }
          stream.close(null);

          const bytes = stream.steal_as_bytes();
          const multipart = new Soup.Multipart(Soup.FORM_MIME_TYPE_MULTIPART);
          multipart.append_form_string(
            'base64Image',
            'data:image/png;base64,' + GLib.base64_encode(bytes.get_data())
          );
          multipart.append_form_string('apikey', SETTING_OCR_API);
          multipart.append_form_string('OCREngine', '2');

          const message = Soup.form_request_new_from_multipart(
            OCR_URL,
            multipart
          );

          this._session.queue_message(
            message,
            function (result, task) {
              const status = message.status_code;
              if (status == Soup.Status.CANCELLED) {
                return;
              }
              if (status !== Soup.Status.OK) {
                lg(
                  '[UIImageRenderer::_processSnipCapture]',
                  'Error occurred during OCR processing:',
                  status,
                  message.response_body.length,
                  Soup.Status.get_phrase(message.status_code)
                );
                this._ocrResultAvailable = false;
                if (
                  status >= Soup.Status.CANT_RESOLVE &&
                  status <= Soup.Status.CANT_CONNECT_PROXY
                ) {
                  this._ocrText.error(
                    _(
                      'Unable to connect.\n' +
                        'Check your internet connection\n' +
                        'and try again.'
                    )
                  );
                } else if (status === Soup.Status.FORBIDDEN) {
                  this._ocrText.error(
                    _(
                      'Your API KEY is invalid.\n' +
                        'Visit https://ocr-space.com\n' +
                        'to renew your KEY'
                    )
                  );
                } else {
                  this._ocrText.error(
                    Soup.Status.get_phrase(message.status_code)
                  );
                }

                return;
              }

              const data = message.response_body.data;
              const obj = JSON.parse(
                message.response_body.length === 0 ? '{}' : data
              );
              const extract = obj?.ParsedResults?.[0]?.ParsedText?.trim() ?? '';
              lg(
                '[UIImageRenderer::_processSnipCapture]',
                'data:',
                data,
                'extract:',
                extract,
                'length:',
                extract?.length ?? 0
              );
              if (extract !== null && extract.length !== 0) {
                this._ocrText.open(extract);
              } else {
                this._ocrText.error(_('Unable to extract information'));
              }
              this._ocrResultAvailable = true;
            }.bind(this)
          );
        }.bind(this)
      );
    }

    _doCopyImage(pixbuf) {
      this._copyImageToClipboard(pixbuf, _('Selection copied'));
    }

    _abortSnipSession() {
      this._snipIndicator.hide();
      this._ocrText.close();
      this._session?.abort();
      this.emit('ocr-cancelled');
    }

    _updateSnipIndicator() {
      let leftX = Math.min(this._originX, this._dragX);
      let topY = Math.min(this._originY, this._dragY);
      const rightX = Math.max(this._originX, this._dragX);
      const bottomY = Math.max(this._originY, this._dragY);
      const width = rightX - leftX + 1;
      const height = bottomY - topY + 1;
      let overshootX = 0,
        overshootY = 0;

      leftX = leftX - this._topParent.x - this._topParent.border_width;
      topY = topY - this._topParent.y - this._topParent.border_width;
      if (leftX < 0) {
        overshootX = leftX;
        leftX = 0;
      }
      if (topY < 0) {
        overshootY = topY;
        topY = 0;
      }

      this._snipIndicator.set_position(leftX, topY);
      this._snipIndicator.set_size(width + overshootX, height + overshootY);
    }

    _updateCursor() {
      global.display.set_cursor(
        this._isInSnipSession ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT
      );
    }

    get ocrReady() {
      return this._ocrResultAvailable === true;
    }

    _onKeyPress(event) {
      const symbol = event.keyval;
      if (symbol === Clutter.KEY_Escape) {
        const before = this._snipIndicator.visible;
        this._abortSnipSession();
        // If we want to exit snip mode entirely
        const { width, height } = this._snipIndicator;
        if (!before || width < 10 || height < 10) {
          this._closeSnipToolkit();
          this._updateCursor();
        }
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Delete) {
        lg(
          '[UIImageRenderer::_onKeyPress]',
          'file to be deleted:',
          this._shotWidget?._filename
        );
        this._shotWidget?.emit('delete');
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Left) {
        this.emit('switch-active', {
          current: this._filename,
          direction: Directivity.PREV
        });
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Right) {
        this.emit('switch-active', {
          current: this._filename,
          direction: Directivity.NEXT
        });
        return Clutter.EVENT_STOP;
      } else if (isSnipAction.bind(this)(symbol)) {
        const oldSymbol = this._snipTrigger;
        this._snipTrigger = symbol;
        if (!oldSymbol || !(this._isInSnipSession && oldSymbol !== symbol)) {
          this._openSnipToolkit();
        }
      } else if (event.modifier_state & Clutter.ModifierType.CONTROL_MASK) {
        if (symbol === Clutter.KEY_r || symbol === Clutter.KEY_R) {
          this._pixbuf = this._pixbuf.rotate_simple(
            GdkPixbuf.PixbufRotation.CLOCKWISE
          );
          this._reOrient(1);
          this._reload();
        } else if (symbol === Clutter.KEY_l || symbol === Clutter.KEY_L) {
          this._pixbuf = this._pixbuf.rotate_simple(
            GdkPixbuf.PixbufRotation.COUNTERCLOCKWISE
          );
          this._reOrient(N_AXIS - 1);
          this._reload();
        } else if (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C) {
          if (event.modifier_state & Clutter.ModifierType.SHIFT_MASK) {
            this._copyImageToClipboard(
              this._visibleRegionPixbuf,
              'Viewport yanked!'
            );
          } else if (!this._isInSnipSession) {
            this._copyImageToClipboard(this._pixbuf, 'Image yanked!');
          } else {
            this._copyTextToClipboard(this._ocrText.get_text(), 'Text copied');
          }
        }
      }

      function isSnipAction(symbol) {
        return !!Object.keys(this._snipActions).find((sym) => sym == symbol);
      }

      return Clutter.EVENT_PROPAGATE;
    }

    _onPress(event, button, sequence) {
      if (this._dragButton) {
        return Clutter.EVENT_PROPAGATE;
      }

      this._dragButton = button;
      this._dragGrab = global.stage.grab(this);
      [this._dragX, this._dragY] = [event.x, event.y];
      [this._originX, this._originY] = [event.x, event.y];
      if (this._isInSnipSession) {
        this._ocrText.close();
        this._snipIndicator.show();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
      } else {
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
      }

      return Clutter.EVENT_STOP;
    }

    _onRelease(event, button, sequence) {
      if (
        this._dragButton !== button ||
        this._dragSequence?.get_slot() !== sequence?.get_slot()
      )
        return Clutter.EVENT_PROPAGATE;

      lg('[UIImageRenderer::_onRelease]');
      this._stopDrag();
      if (this._isInSnipSession) {
        this._processSnipCapture();
      }

      const [x, y] = [event.x, event.y];
      global.display.set_cursor(Meta.Cursor.DEFAULT);

      return Clutter.EVENT_STOP;
    }

    _stopDrag() {
      if (!this._dragButton) return;

      this._dragButton = 0;
      this._dragGrab?.dismiss();
      this._dragGrab = null;
      this._dragSequence = null;
    }

    _onMotion(event, sequence) {
      const [x, y] = [event.x, event.y];
      if (!this._dragButton) {
        this._updateCursor();
        return Clutter.EVENT_STOP;
      }

      let dx = Math.round(x - this._dragX);
      let dy = Math.round(y - this._dragY);

      const [maxWidth, maxHeight] = [
        this._pixbuf.get_width(),
        this._pixbuf.get_height()
      ];

      if (!this._isInSnipSession) {
        const panDirection = SETTING_NATURAL_PANNING ? -1 : 1;
        if (maxWidth > this.width) {
          this._xpos += panDirection * dx;
          if (this._xpos < 0) {
            const overshootX = -this._xpos;
            this._xpos += overshootX;
            dx -= overshootX;
          }
          if (this._xpos + this.width - 1 >= maxWidth) {
            const overshootX = maxWidth - (this._xpos + this.width - 1);
            this._xpos += overshootX;
            dx -= overshootX;
          }
        } else {
          dx = 0;
        }

        if (maxHeight > this.height) {
          this._ypos += panDirection * dy;
          if (this._ypos < 0) {
            const overshootY = -this._ypos;
            this._ypos += overshootY;
            dy -= overshootY;
          }
          if (this._ypos + this.height - 1 >= maxHeight) {
            const overshootY = maxHeight - (this._ypos + this.height - 1);
            this._ypos += overshootY;
            dy -= overshootY;
          }
        } else {
          dy = 0;
        }
        this._canvas.invalidate();
      } else {
        this._updateSnipIndicator();
      }

      this._dragX += dx;
      this._dragY += dy;
      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onPress(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onRelease(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

    vfunc_touch_event(event) {
      const eventType = event.type;
      if (eventType === Clutter.EventType.TOUCH_BEGIN)
        return this._onPress(event, 'touch', event.get_event_sequence());
      else if (eventType === Clutter.EventType.TOUCH_END)
        return this._onRelease(event, 'touch', event.get_event_sequence());
      else if (eventType === Clutter.EventType.TOUCH_UPDATE)
        return this._onMotion(event, event.get_event_sequence());

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
      lg('[UIImageRenderer::vfunc_leave_event]');
      if (this._dragButton) {
        return this._onMotion(event, null);
      } else {
        global.display.set_cursor(Meta.Cursor.DEFAULT);
      }

      return super.vfunc_leave_event(event);
    }
  }
);

const UIOcrTip = GObject.registerClass(
  class UIOcrTip extends St.Label {
    _init(widget, container, params) {
      super._init(params);

      this._widget = widget;
      this._container = container;
      this._timeoutId = null;

      this.connect('destroy', this._onDestroy.bind(this));
      this._container.connect(
        'ocr-cancelled',
        function () {
          this._openCancelled = true;
          this.close();
        }.bind(this)
      );
    }

    open(message, instantly = false) {
      this.remove_style_class_name('pixzzle-ui-ocrtip-error');
      if (this._timeoutId) {
        this.close(true /* instantly */);
      }

      this._open(
        function () {
          const x = this._widget.x;
          const y = this._widget.y;
          this.show();
          this.set_text(message);
          this.set_position(x, y);
        }.bind(this),
        instantly
      );
    }

    _open(action, instantly = false) {
      if (instantly) {
        this.set_opacity(0);
        action();
        this.ease({
          opacity: FULLY_OPAQUE,
          duration: 150,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._openCancelled = false;
        return;
      }

      this._timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        150,
        function () {
          lg('[OcrTip::_open::timeout_add()]', this._openCancelled);
          if (this._openCancelled) {
            this._openCancelled = false;
            this.close(true /* instantly */);
          } else {
            this.set_opacity(0);
            this.show();
            action();
            this.ease({
              opacity: FULLY_OPAQUE,
              duration: 150,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
          }
          this._timeoutId = null;
          return GLib.SOURCE_REMOVE;
        }.bind(this)
      );
      GLib.Source.set_name_by_id(this._timeoutId, '[pixzzle] ocrtip._open');
    }

    close(instantly = false) {
      if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = null;
      }

      if (!this.visible) return;

      this.remove_all_transitions();
      if (instantly) {
        this.hide();
        return;
      }

      this.ease({
        opacity: 0,
        duration: 100,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.hide()
      });
    }

    error(message) {
      lg('[OcrTip::error]', 'error:', message, this._timeoutId);
      if (this._timeoutId) {
        this.close(true /* instantly */);
      }

      this._open(
        function () {
          lg('[OcrTip::error::_open::()]');
          const style_classes = this.get_style_class_name()?.split(' ') ?? [];
          const rem_style_classes = style_classes.filter(
            (style_class) => style_class !== 'pixzzle-ui-ocrtip-error'
          );

          rem_style_classes.push('pixzzle-ui-ocrtip-error');
          this.set_style_class_name(rem_style_classes.join(' '));
          this.set_text(message);
          this._vibrateWithDamping();
        }.bind(this)
      );
    }

    _vibrateWithDamping() {
      let originalPosition = this._widget.x - this.width / 2;
      let counter = 0;
      // Change this value to adjust the rate of damping
      let dampingFactor = 1;
      function frame() {
        this.__ocrTipTimeoutId = null;
        counter += 0.9;
        // This value determines how quickly the vibration dampens
        dampingFactor *= 0.86;
        const offset = Math.sin(counter) * 80 * dampingFactor;
        // The amplitude of the vibration decreases over time
        this.set_position(originalPosition + offset, this._widget.y);

        if (dampingFactor < 0.01) {
          // When the vibration is small enough, stop the animation
          // and reset the position
          this.set_position(originalPosition, this._widget.y);
        } else {
          this.__ocrTipTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000 / 60,
            frame.bind(this)
          );
          GLib.Source.set_name_by_id(
            this.__ocrTipTimeoutId,
            '[pixzzle-ui] OcrTip.error.vibrateWithDamping.frame'
          );
        }

        return GLib.SOURCE_REMOVE;
      }

      frame.bind(this)();
    }

    _onDestroy() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }

      if (this.__ocrTipTimeoutId) {
        GLib.Source.remove(this.__ocrTipTimeoutId);
        this.__ocrTipTimeoutId = null;
      }
    }

    _onMotion(event) {
      return Clutter.EVENT_STOP;
    }

    vfunc_allocate(box) {
      const [width, height] = [box.get_width(), box.get_height()];
      box.set_size(clamp(width, 300), clamp(height, 200));
      this.set_allocation(box);

      super.vfunc_allocate(box);

      function clamp(value, max) {
        return value > max ? max : value;
      }
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      ) {
        if (this._container.ocrReady) {
          this._container._copyTextToClipboard(this.get_text(), 'Text copied');
        }
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

    vfunc_enter_event(event) {
      lg('[Tooltip::vfunc_enter_event]');
      return super.vfunc_enter_event(event);
    }
  }
);

const UISideViewBase = GObject.registerClass(
  class UISideViewBase extends St.BoxLayout {
    _init(params) {
      super._init({ ...params, y_expand: true });

      this._scrollView = new UIScrollView({
        style_class: 'pixzzle-ui-thumbnail-scrollview',
        hscrollbar_policy: St.PolicyType.EXTERNAL,
        vscrollbar_policy: St.PolicyType.EXTERNAL,
        enable_mouse_scrolling: true,
        y_expand: true,
        reactive: true
      });
      this.add_child(this._scrollView);
      this._scrollView.set_overlay_scrollbars(false);

      this._viewBox = new St.Viewport({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: 6
        }),
        y_align: Clutter.ActorAlign.START,
        y_expand: true
      });
      this._scrollView.add_actor(this._viewBox);
    }
  }
);

const UIThumbnailViewer = GObject.registerClass(
  {
    GTypeName: 'UIThumbnailViewer',
    Signals: { replace: { param_types: [Object.prototype] } },
    Properties: {
      loaded: GObject.ParamSpec.boolean(
        'loaded',
        'loaded',
        'loaded',
        GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
        false,
        true,
        false
      )
    }
  },
  class UIThumbnailViewer extends UISideViewBase {
    _init(sibling, params) {
      super._init(params);

      this._sibling = sibling;
      this.connect('destroy', this._onDestroy.bind(this));
    }

    _initialize(payload, onComplete) {
      if (!this._initialized) {
        this._loadShots(payload)
          .then(([shots, batch]) => {
            this.emit('replace', shots[0] ?? {});
            onComplete?.();
            this._initialized = true;
            this.notify('loaded');
            this._streamBatch(batch);
          })
          .catch((err) => logError(err, 'Unable to load previous state'));
      }
    }

    reload(shots, cb) {
      this._initialized = false;
      this._initialize(shots, cb);
    }

    _streamBatch(batch) {
      this.cancelSubscriptions();
      if (batch.length === 0) {
        return;
      }

      const CHUNK = 4;
      let index = 0;
      this._batchId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        300,
        function () {
          const next = batch.slice(index, index + CHUNK);
          for (const shot of next) {
            this._addShot(shot);
          }
          lg(
            '[UIThumbnailViewer::_streamBatch::timeout_add]',
            'index:',
            index,
            'current:',
            next.length
          );
          index += next.length;
          this._nextBatch = batch.slice(index);
          if (next.length === 0) {
            this.cancelSubscriptions();
            return GLib.SOURCE_REMOVE;
          }

          return GLib.SOURCE_CONTINUE;
        }.bind(this)
      );
      GLib.Source.set_name_by_id(
        this._batchId,
        '[pixzzle] UIThumbnailViewer._streamBatch'
      );
    }

    cancelSubscriptions() {
      if (this._batchId) {
        GLib.source_remove(this._batchId);
        this._batchId = null;
      }
    }

    /**
     * If there's a paused batching operation,
     * resume it. A batch is a collection
     * of shots that are yet to be added
     * to the stage (ThumbnailViewer).
     * When main window is hidden, we don't
     * want any background actions running.
     * Hiding the main window before some
     * actions complete causes the view
     * to have incomplete data. We continue
     * with such operations.
     */
    activateSubscriptions() {
      if (!this._nextBatch?.length) {
        return;
      }

      this._streamBatch(this._nextBatch);
    }

    _maxVisibleShots() {
      const sibling_extent = this._sibling.get_transformed_extents();
      const this_extent = this.get_transformed_extents();
      const isSiblingNaN = Number.isNaN(sibling_extent.get_height());
      const isThisNaN = Number.isNaN(this_extent.get_height());
      const sibling_height = isSiblingNaN
        ? INITIAL_HEIGHT * 0.8
        : sibling_extent.get_height();
      const this_height = isThisNaN
        ? INITIAL_HEIGHT * 0.8
        : this_extent.get_height();

      const effective_height = Math.max(this_height, sibling_height);
      return Math.floor(effective_height / this.width);
    }

    _addShot(newShot, prepend) {
      const shot = new UIPreview(newShot, this.width);
      shot.connect('activate', (widget) => {
        this.emit('replace', { name: widget._filename, widget: shot });
      });
      shot.connect('delete', (widget) => {
        this._removeShot(shot).then((filename) => {
          const nextShot = this._viewBox.get_child_at_index(0);
          this.emit('replace', {
            name: nextShot?._filename ?? null,
            widget: nextShot
          });
          const name = GLib.path_get_basename(filename);
          const thumbnail = GLib.build_filenamev([
            getThumbnailsLocation().get_path(),
            name
          ]);

          GLib.unlink(filename);
          GLib.unlink(thumbnail);
          this._sibling.removeShot(this._date, filename);

          if (!nextShot) {
            this.reload();
          }
        });
      });

      if (prepend) {
        this._viewBox.insert_child_at_index(shot, 0);
      } else {
        this._viewBox.add_child(shot);
      }

      return { name: shot._filename, widget: shot };
    }

    _addNewShot(newShot) {
      const shot = this._addShot(newShot.name, true /* prepend */);
      this.emit('replace', { ...newShot, ...shot });
    }

    _switchActive(detail) {
      const { current: filename, direction } = detail;
      if (filename === null) {
        return;
      }

      const shots = this._viewBox.get_children();
      let next = -1;
      for (let i = 0; i < shots.length; ++i) {
        const shot = shots[i];
        if (filename === shot._filename) {
          next = i + direction;
          next = (next < 0 ? next + shots.length : next) % shots.length;
          break;
        }
      }
      if (next === -1) {
        return;
      }

      shots[next].emit('activate');
    }

    _shotCount() {
      return this._viewBox.get_children().length;
    }

    async _removeShot(widget) {
      return new Promise((resolve, reject) => {
        widget.ease({
          opacity: 0,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => {
            const file = widget._filename;
            this._viewBox.remove_actor(widget);
            resolve(file);
          }
        });
      });
    }

    async _loadShots(payload) {
      this._viewBox.destroy_all_children();
      const bundle = payload ?? (await this._sibling.latestShot());
      lg('[UIThumbnailViewer::_loadShots]', 'payload:', bundle.shots.length);
      this._is_flat = bundle.is_flat;
      this._date = bundle.date;
      const shots = [];
      const section = bundle.shots.slice(0, this._maxVisibleShots());
      lg(
        '[UIThumbnailViewer::_loadShots]',
        'number of initial thumbs:',
        section.length,
        'total number of shots:',
        bundle.shots.length
      );
      for (const shot of section) {
        shots.push(this._addShot(shot));
      }
      const newShotProps = bundle.nid;
      if (newShotProps) {
        this.emit('replace', { ...newShotProps, ...shots[0] });
      }

      const unloaded = bundle.shots.slice(section.length);

      return [shots, unloaded];
    }

    get loading() {
      return !this._initialized;
    }

    _onDestroy() {
      this.cancelSubscriptions();
    }
  }
);

const UIPreview = GObject.registerClass(
  { GTypeName: 'UIPreview', Signals: { activate: {}, delete: {} } },
  class UIPreview extends St.Widget {
    _init(filename, span, params) {
      super._init({ ...params, y_expand: false });

      this._surface = new St.Widget({ x_expand: false, y_expand: false });
      this.add_child(this._surface);

      const [thumbnail, actualFile] = this._getThumbnail(filename);
      let pixbuf;
      if (!thumbnail) {
        const baseBuf = GdkPixbuf.Pixbuf.new_from_file(filename);
        pixbuf = baseBuf.new_subpixbuf(0, 0, span, span);
        if (pixbuf === null) {
          const aspectRatio = baseBuf.get_width() / baseBuf.get_height();
          pixbuf = baseBuf
            .scale_simple(
              span,
              Math.max((span * 1.0) / aspectRatio, span),
              GdkPixbuf.InterpType.BILINEAR
            )
            .new_subpixbuf(0, 0, span, span);
          pixbuf.set_option(TINY_IMAGE, 'true');
        }

        this._saveThumbnail(pixbuf, actualFile);
      } else {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file(actualFile);
      }
      const isTiny = pixbuf.get_option(TINY_IMAGE) === 'true';

      if (isTiny) {
        /*
         * If original image is smaller than thumbnail,
         * scale and blur the thumbnail.
         */
        this._surface.add_effect(
          new Shell.BlurEffect({
            brightness: FULLY_OPAQUE,
            mode: Shell.BlurMode.ACTOR,
            sigma: 2.5
          })
        );
      }

      this._filename = filename;
      this._image = Clutter.Image.new();
      this._image.set_data(
        pixbuf.get_pixels(),
        pixbuf.get_has_alpha()
          ? Cogl.PixelFormat.RGBA_8888
          : Cogl.PixelFormat.RGB_888,
        pixbuf.get_width(),
        pixbuf.get_height(),
        pixbuf.get_rowstride()
      );
      this._surface.set_content(this._image);
      this._surface.set_size(span, span);

      this._trigger = new St.Button();
      this.add_child(this._trigger);

      this._trigger.add_constraint(
        new Clutter.BindConstraint({
          source: this,
          coordinate: Clutter.BindCoordinate.WIDTH
        })
      );
      this._trigger.add_constraint(
        new Clutter.BindConstraint({
          source: this,
          coordinate: Clutter.BindCoordinate.HEIGHT
        })
      );
      this._trigger.connect('clicked', () => {
        lg('[UIPreview::_init::_trigger::clicked]');
        this.emit('activate');
      });

      this._removeButton = new St.Button({
        style_class: 'pixzzle-ui-thumbnail-close-button',
        child: new St.Icon({ icon_name: 'preview-close-symbolic' }),
        x: 0,
        y: 0
      });
      this._removeButton.add_constraint(
        new Clutter.AlignConstraint({
          source: this,
          align_axis: Clutter.AlignAxis.X_AXIS,
          pivot_point: new Graphene.Point({ x: 1, y: 0 }),
          factor: 1
        })
      );
      this._removeButton.add_constraint(
        new Clutter.AlignConstraint({
          source: this,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          pivot_point: new Graphene.Point({ x: 0, y: 0 }),
          factor: 0
        })
      );
      this.add_child(this._removeButton);

      this._removeButton.connect('clicked', () => {
        lg('[UIPreview::_init::_closeButton::clicked]');
        this.emit('delete');
      });
    }

    _getThumbnail(filename) {
      const dir = getThumbnailsLocation();
      const base = GLib.path_get_basename(filename);
      const thumbnail = GLib.build_filenamev([dir.get_path(), base]);
      if (GLib.file_test(thumbnail, GLib.FileTest.EXISTS)) {
        return [true, thumbnail];
      }

      return [false, thumbnail];
    }

    _saveThumbnail(image, filename) {
      const file = Gio.File.new_for_path(filename);
      const stream = file.create(Gio.FileCreateFlags.NONE, null);
      image.save_to_streamv_async(stream, 'png', [], [], null, (_, task) => {
        if (!GdkPixbuf.Pixbuf.save_to_stream_finish(task)) {
          return;
        }
        stream.close(null);
      });
    }
  }
);

const UIFolderViewer = GObject.registerClass(
  {
    GTypeName: 'UIFolderViewer',
    Signals: {
      replace: { param_types: [Object.prototype] },
      'swap-view': { param_types: [Object.prototype] }
    }
  },
  class UIFolderViewer extends UISideViewBase {
    _init(params) {
      super._init(params);
      this._folders = {};
    }

    _addShot(name, shots, gradient, extras = {}, prepend = false) {
      const folder = new UIFolder(name, shots, gradient, {
        style_class: 'pixzzle-ui-folder'
      });
      folder.connect('activate', (widget, params) => {
        /* If `params` is empty, the `shots` array doesn't contain
         * a new screenshot. Don't send `extras` which may contain
         * stale shots data. We do this because of properties such
         * as `nid` used in tagging of new shots. This property
         * is used in determining if for example ocr should be
         * performed once the shot is staged. If `extras` is not
         * cleared, ocr action will be repeatedly performed once
         * the shot with the `ocr` property is staged.
         */
        const override =
          Object.keys(params).length == 0 ? {} : { ...extras, ...params };
        this.emit('swap-view', {
          shots: widget._shots,
          date: name,
          ...override
        });
      });
      /*
      shot.connect('delete', (widget) => {
        this._removeShot(widget).then((filename) => {
          const nextShot = this._viewBox.get_child_at_index(0);
          this.emit('replace', {
            name: nextShot?._filename ?? null,
            widget: widget
          });
          GLib.unlink(filename);
        });
      }); */
      if (prepend) {
        this._viewBox.insert_child_at_index(folder, 0);
      } else {
        this._viewBox.add_child(folder);
      }

      folder.set_size(this.width, this.width);
      this._folders[name] = folder;

      return folder;
    }

    async latestShot() {
      if (!this._shotGroups) {
        await this._loadShots();
      }

      const today = fmt(Date.now());
      if (this._shotGroups[today]) {
        return { shots: this._shotGroups[today], date: today };
      }

      const date = this._shotsDate[0];
      if (this._shotGroups[date]) {
        return { shots: this._shotGroups[date], date };
      }
      return { shots: [], date: null };
    }

    async addNewShot(newShot) {
      if (!this._shotGroups) {
        await this._loadShots();
      }

      /*
       * The `nid` property sent via the `activate`
       * signal helps distinguish new screenshots
       * with metadata attached from stale shots.
       */
      const today = fmt(Date.now());
      if (!this._shotGroups[today]) {
        this._shotGroups[today] = [newShot.name];
        const folder = this._addShot(
          today,
          this._shotGroups[today],
          this._gradients[Math.floor(Math.random() * this._gradients.length)],
          { nid: newShot },
          true /* prepend */
        );
        folder.emit('activate', {});
      } else {
        // Insert new shots name at the front to maintain
        // sort ordering.
        this._shotGroups[today].unshift(newShot.name);
        const folder = this._viewBox.get_child_at_index(0);
        folder.emit('activate', { nid: newShot });
      }
    }

    removeShot(date, shot) {
      lg(
        '[UIFolderViewer::removeShot]',
        'date:',
        date,
        'shot:',
        shot,
        this._shotsDate
      );

      const [index, new_date] = this._locate(shot, date);
      this._shotGroups[new_date].splice(index, 1);
      if (this._shotGroups[new_date].length === 0) {
        delete this._shotGroups[new_date];
      }
      if (this._shotGroups[new_date]) {
        return;
      }

      if (this._shotsDate[0] === new_date) {
        this._shotsDate.splice(0, 1);
      }
      this._viewBox.remove_actor(this._folders[new_date]);
      delete this._folders[new_date];
    }

    _locate(shot, date) {
      for (const d of date ? [date] : this._shotsDate) {
        const idx = this._shotGroups[d].findIndex((name) => name === shot);
        if (idx !== -1) {
          return [idx, d];
        }
      }
    }

    async _loadShots() {
      const gradientsLocation = GLib.build_filenamev([
        Me.path,
        'objects',
        'gradients.json'
      ]);
      const content = Shell.get_file_contents_utf8_sync(gradientsLocation);
      let snapshotDir = getShotsLocation();
      if (!snapshotDir.query_exists(null)) {
        return;
      }

      const allShots = await this._processShots(snapshotDir);
      // Group shots taken on the same day together
      const cluster = {};
      const gradients = JSON.parse(content);
      shuffle(gradients);
      this._gradients = gradients;
      // Keep an ordered list of dates shots were taken
      this._shotsDate = [];
      for (const shot of allShots) {
        const date = fmt(getDate(shot));
        if (cluster[date] == null) {
          cluster[date] = [shot];
          this._shotsDate.push(date);
        } else {
          cluster[date].push(shot);
        }
      }

      function shuffle(array) {
        let count = array.length,
          randomnumber,
          temp;
        while (count) {
          randomnumber = (Math.random() * count--) | 0;
          temp = array[count];
          array[count] = array[randomnumber];
          array[randomnumber] = temp;
        }
      }

      this._shotGroups = cluster;
      lg('[UIFolderViewer::_loadShots::_shotGroups]', cluster);

      return Object.entries(cluster).map(([name, shots], index) =>
        this._addShot(
          name,
          shots,
          this._gradients[index % this._gradients.length]
        )
      );
    }

    async flatten() {
      if (!this._shotGroups) {
        await this._loadShots();
      }

      const shots = Object.entries(this._shotGroups).reduce(
        (acc, [key, value]) => acc.concat(value),
        []
      );
      shots.sort(filesDateSorter);
      this.emit('swap-view', { shots, is_flat: true });
    }

    async activate(n) {
      lg('[UIFolderViewer::activate]', 'triggering ', n);
      this._folders[n]?.emit('activate', {});
    }

    _processShots(directory) {
      const DEFAULT_ATTRIBUTES = 'standard::*';
      return new Promise((resolve, reject) => {
        if (this._entriesEnumerateCancellable) {
          this._entriesEnumerateCancellable.cancel();
        }
        this._entriesEnumerateCancellable = new Gio.Cancellable();
        directory.enumerate_children_async(
          DEFAULT_ATTRIBUTES,
          Gio.FileQueryInfoFlags.NONE,
          GLib.PRIORITY_DEFAULT,
          this._entriesEnumerateCancellable,
          (source, result) => {
            this._entriesEnumerateCancellable = null;
            const files = [];
            try {
              let fileEnum = source.enumerate_children_finish(result);
              let info;
              while ((info = fileEnum.next_file(null))) {
                const filename = GLib.build_filenamev([
                  directory.get_path(),
                  info.get_name()
                ]);
                if (!GLib.file_test(filename, GLib.FileTest.IS_DIR)) {
                  files.push(filename);
                }
              }
            } catch (e) {
              if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                resolve([]);
              } else {
                reject('file-read-error');
              }
              return;
            }
            files.sort(filesDateSorter);
            resolve(files);
            return;
          }
        );
      });
    }
  }
);

const UIFolder = GObject.registerClass(
  {
    GTypeName: 'UIFolder',
    Signals: {
      activate: {
        param_types: [Object.prototype]
      },
      delete: {}
    }
  },
  class UIFolder extends St.Widget {
    _init(name, shots, gradient, params) {
      super._init({ ...params, layout_manager: new Clutter.BinLayout() });

      this._shots = shots;
      this._label = new St.Label({
        text: name,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
        style_class: 'pixzzle-ui-folder-label'
      });
      this._label.clutter_text.set_line_wrap(true);
      this.set_style(singleStyle(gradient));
      this.add_child(this._label);

      this._trigger = new St.Button({
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        y_expand: true
      });
      this.add_child(this._trigger);

      this._trigger.connect('clicked', () => {
        lg('[UIFolder::_init::_trigger::clicked]');
        this.emit('activate', {});
      });

      function singleStyle(styles) {
        return Object.entries(styles).reduce(
          (acc, [k, v]) => acc + `${k}:${v};`,
          ''
        );
      }
    }
  }
);

const GBoolean = GObject.registerClass(
  {
    Properties: {
      changed: GObject.ParamSpec.boolean(
        'changed',
        'changed',
        'changed',
        GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
        false,
        true,
        false
      )
    }
  },

  class GBoolean extends GObject.Object {
    _init(initial_state) {
      super._init();

      this._value = initial_state;
    }

    get_value() {
      return this._value;
    }

    set_value(new_val) {
      if (new_val === this._value) {
        return;
      }

      this._value = new_val;
      this.notify('changed');
    }
  }
);

/*
 *  Wrapper classes are provided to override the computation
 *  of cursor type in `UIMainViewer`. This way, we don't
 *  have to handle extra computation of what the cursor has
 *  to be in these views, we just update the cursor type
 *  in these widgets.
 */
const UIButton = GObject.registerClass(
  class UIButton extends St.Button {
    _init(params) {
      super._init(params);
    }

    vfunc_motion_event(event) {
      return Clutter.EVENT_STOP;
    }
  }
);

const UIScrollView = GObject.registerClass(
  class UIScrollView extends St.ScrollView {
    _init(params) {
      super._init(params);
    }

    vfunc_motion_event(event) {
      global.display.set_cursor(Meta.Cursor.DEFAULT);
      return Clutter.EVENT_STOP;
    }
  }
);

const UILayout = GObject.registerClass(
  class UILayout extends St.BoxLayout {
    _init(params) {
      super._init(params);
    }

    get spacing() {
      if (!this._spacing) {
        this._spacing = this.get_theme_node().get_length('spacing');
      }

      return this._spacing;
    }

    get bottom_padding() {
      if (!this._bottom_padding) {
        this._bottom_padding =
          this.get_theme_node().get_length('padding-bottom');
      }

      return this._bottom_padding;
    }

    vfunc_button_press_event(event) {
      return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
      return Clutter.EVENT_STOP;
    }
  }
);
