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
/**
 * Gdk cannot be imported into shell process, hence
 * we import only what we need. We want to get the
 * current cursor position.
 */
const Display = imports.gi.Gdk.Display;
const Cairo = imports.cairo;
const File = Gio.File;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
const _ = Gettext.domain('pixzzle').gettext;

const {
  inflateSettings,
  lg,
  getShotsLocation,
  getIconsLocation,
  getThumbnailsLocation,
  getDate,
  filesDateSorter,
  fmt,
  Constants
} = Me.imports.utils;
const { storeScreenshot, ensureActorVisibleInScrollView } = Me.imports.common;
const Shutter = Me.imports.screenshot;
const Overlay = Me.imports.overlay;
const { computePanelPosition } = Me.imports.panel;
const Panel = computePanelPosition();
const Prefs = Me.imports.prefs;
const { getActionWatcher } = Me.imports.watcher;
const { Timer } = Me.imports.timer;
const { UITooltip } = Me.imports.tooltip;
const { UIImageRenderer } = Me.imports.renderer;
const Dialog = Me.imports.dialog;
const Docking = Me.imports.dock.docking;
const DockUtil = Me.imports.dock.utils;

const INITIAL_WIDTH = 500;
const INITIAL_HEIGHT = 600;
const ALLOWANCE = 80;
const EDGE_THRESHOLD = 2;
const MODAL_CHECK_INTERVAL = 300;
const OCCLUSION_THRESHOLD = 50;
/*
 * Store metadata in image ancillary chunk
 * to detect if the image is smaller than
 * the size of thumbnail view. This kinds
 * of images are blurred to reduce pixellation.
 */
const TINY_IMAGE = 'tINy';

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

      const seat = Clutter.get_default_backend().get_default_seat();
      this._dragButton = 0;
      this._dragSequence = null;
      this._pointerDev = seat.get_pointer();

      this._startX = -1;
      this._startY = 0;
      this._lastX = 0;
      this._lastY = 0;

      this._isActive = false;
      this._emptyView = true;
      this._isFlattened = new GBoolean(true);

      Main.layoutManager.addChrome(this);
      DockUtil.registerAppOwner(DockUtil.AppsID.TAKE_SCREENSHOT, {
        activate: this._showScreenshotView.bind(this)
      });

      this._overlay = new Overlay.UIOverlay(this);

      /*
       * Watch for new modal dialog and hide viewer
       * when there's a change in the number of dialogs
       * visible as defined by `Main.modalCount`.
       * If our modal is visible, don't hide viewer.
       * FIXME: Disable watch when the modal is visible
       * and re-enable once the modal is hidden.
       */
      this._watcher = getActionWatcher().addWatch(MODAL_CHECK_INTERVAL, {
        reaction: this._close.bind(this, true /* instantly */),
        compare: (one, other) => one === other,
        action: () => Main.modalCount * !this._overlay.visible
      });

      this.reset();

      this._box = new St.Widget({
        name: 'UIMainViewerLayout',
        x_expand: true,
        y_expand: true
      });
      this.add_child(this._box);

      this._closeButton = new UIButton({
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

      this._buttonBox = new UILayout({
        name: 'UIButtonBox',
        x: 0,
        y: 0,
        vertical: false,
        x_expand: true,
        y_expand: false,
        x_align: Clutter.ActorAlign.END
      });
      this._box.add_child(this._buttonBox);
      this._buttonBox.add_constraint(
        new Clutter.AlignConstraint({
          source: this._box,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          pivot_point: new Graphene.Point({ x: -1, y: 1 }),
          factor: 1.0
        })
      );
      this._buttonBox.add_constraint(
        new Clutter.BindConstraint({
          source: this._box,
          coordinate: Clutter.BindCoordinate.WIDTH,
          offset: 0
        })
      );

      this._swapView = new UILayout({
        name: 'UISwapView',
        vertical: true,
        y_expand: true,
        reactive: true,
        y_align: Clutter.ActorAlign.FILL
      });
      this._swapView.set_clip_to_allocation(true);
      this._box.add_child(this._swapView);
      this._swapView.add_constraint(
        new Clutter.SnapConstraint({
          source: this._box,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.TOP,
          offset: -this.border_width
        })
      );
      this._swapView.add_constraint(
        new Clutter.SnapConstraint({
          source: this._buttonBox,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.TOP,
          offset: -this.border_width
        })
      );
      this._settingsButton = new UIButton({
        style_class: 'pixzzle-ui-settings-button',
        child: new St.Icon({
          icon_name: 'org.gnome.Settings-symbolic'
        }),
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
      const swapIconName = 'pixzzle-ui-swap-symbolic.svg';
      this._swapIcon = new St.Icon({
        gicon: Gio.icon_new_for_string(
          `${getIconsLocation().get_path()}/${swapIconName}`
        ),
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

      this._thumbnailView = new UIThumbnailViewer({
        name: 'UIThumbnailViewer',
        sibling: this._folderView,
        x_expand: false,
        y_expand: true,
        visible: true
      });

      this._imageView = new UIImageRenderer(this);
      this._box.add_child(this._imageView);
      this._imageView.add_constraint(
        new Clutter.SnapConstraint({
          source: this._box,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.TOP,
          offset: -this.border_width
        })
      );
      this._imageView.add_constraint(
        new Clutter.SnapConstraint({
          source: this._buttonBox,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.TOP,
          offset: -this.border_width
        })
      );
      this._dock = new Docking.DockedDash({
        height: 0.9 * this.height,
        docker: this._imageView
      });
      this._dock.connect('notify::width', () => this._updateDockPosition());
      this._thumbnailView.connect('replace', (_, shot) => {
        this._imageView._replace(shot);
        this._folderView._setFocusOn(shot.name);
        this._emptyView = this._thumbnailView._shotCount() == 0;
        if (this._emptyView) {
          this._swapButton.checked = true;
          this._imageView.abortSnipSession();
        } else {
          this._dock._enableApps();
        }
      });
      this._thumbnailView.connect('enter-event', this._stopDrag.bind(this));
      this._thumbnailView.connect('notify::loaded', () => {
        lg('[UIMainViewer::_init::_thumbnailView::notify::loaded]');
        this._emptyView = this._thumbnailView._shotCount() == 0;
        if (this._emptyView) {
          this._dock.dash._setAppsDisabledOnLoad();
        }
        this._toggleSwap(this._swapButton);
      });

      this._swapView.add_child(this._thumbnailView);
      this._swapView.add_child(this._folderView);

      const collapseIconName = 'pixzzle-ui-collapse-symbolic.png';
      const collapseIcon = new St.Icon({
        gicon: Gio.icon_new_for_string(
          `${getIconsLocation().get_path()}/${collapseIconName}`
        ),
        rotation_angle_z: 0
      });
      this._meltButton = new UIButton({
        style_class: 'pixzzle-ui-melt-button',
        child: collapseIcon,
        x_expand: false,
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        visible: !this._isFlattened.get_value(),
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        x: 0,
        y: 0
      });
      this.add_child(this._meltButton);

      this._meltButton.connect('clicked', () => {
        this._isFlattened.set_value(true);
      });
      this._isFlattened.connect('notify::changed', (me) => {
        if (me.get_value()) {
          this._folderView.flatten();
        }
        this._animateFlatten(me.get_value());
      });

      this._imageView.connect('lock-axis', (_, axis) => {
        lg('[UIMainViewer::_init::_imageView::lock-axis]');
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

        this._updateDockPosition();
      });
      this._imageView.connect('clean-slate', () => {
        this._maxXSwing = INITIAL_WIDTH;
        this._maxYSwing = INITIAL_HEIGHT;
        const xOffset = this.width - INITIAL_WIDTH;
        const yOffset = this.height - INITIAL_HEIGHT;
        if (xOffset > 0) this._startX += xOffset;
        if (yOffset > 0) this._startY += yOffset;

        this._updateSize();
        this._updateDockPosition();
        this._emptyView = true;
        this._dock._disableApps();
        lg('[UIMainViewer::_init::_imageView::clean-slate] clean');
      });
      this._imageView.connect('enter-event', this._stopDrag.bind(this));
      this._imageView.connect('switch-active', (me, detail) => {
        lg('[UIMainViewer::_init::_imageViewer::switch-active]');
        this._thumbnailView._switchActive(detail);
      });
      this._imageView.connect('new-shot', (me, shot) => {
        this._folderView
          .addNewShot({ name: shot })
          .then(() => this._dock._show())
          .catch(logError);
      });
      this._imageView.connect('drag-action', () => {
        this._dock._hide();
      });
      this.add_child(this._dock);

      this.connect('notify::mapped', () => {
        this._animateSettings();
        // Run only once for the lifetime of the
        // application
        if (!this._viewInitialized) {
          this._folderView.flatten();
          this._updateDockPosition();

          this._viewInitialized = true;
        }
      });

      this._loadSettings();
      this.connect('destroy', this._onDestroy.bind(this));
      this._reload_theme();
    }

    _updateDockPosition() {
      const side = this._dock._slider.swipe;
      const swipeLeft = side === St.Side.RIGHT;
      const border = this.border_width;
      const shotHeight = this._screenshotButton.height;
      const imageViewHeight = this.height - border * 3 - shotHeight;
      const x = border + this._swapView.width + 20;
      const y = border + Math.floor(imageViewHeight - this._dock.height) / 2;
      const swOff = swipeLeft ? this.width : x * 2 + this._dock.width + 20;
      this._dock.set_position(swOff - x, y);
    }

    get border_width() {
      if (!this._border_width) {
        this._border_width = this.get_theme_node().get_length('border-width');
      }

      return this._border_width;
    }

    _openSnipToolkit() {
      this._imageView._openSnipToolkit();
    }

    _computeBigViewSize() {
      const border = this.border_width;
      const width = this.width - this._swapView.width - border * 2 - 20;
      const height = this.height - border * 2 - border - this._buttonBox.height;
      lg(
        '[UIMainViewer::_computeBigViewSize] width:',
        width,
        'height:',
        height
      );
      return [width, height];
    }

    _showScreenshotView() {
      if (!this._shutter) {
        this._shutter = new Shutter.UIShutter();
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
          }
        });
      } else {
        this._meltButton.show();
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
      this._animateSwap();
      // folder hidden
      if (widget.checked) {
        // Bring the active folder view into focus
        this._crossSlideAnimate(this._folderView, this._thumbnailView, () =>
          this._folderView._setFocusOnCurrentFolder()
        );
      } else {
        this._crossSlideAnimate(this._thumbnailView, this._folderView);
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

    _crossSlideAnimate(one, other, cb) {
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
      one.ease({
        height: other.height,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_IN_OUT,
        onComplete: () => cb?.()
      });
      other.ease({
        height: 0,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_IN,
        onComplete: () => (other.visible = false)
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

      this._settingsId = global.window_manager.connect('map', () => {
        lg('[UIMainViewer::_init::window_manager::map]');
        if (!this._settingsWindow()) {
          return;
        }
        this._adjustPreferencesWindow();
        global.window_manager.disconnect(this._settingsId);
      });

      ExtensionUtils.openPrefs();
    }

    _adjustPreferencesWindow() {
      lg('[UIMainViewer::_adjustPreferencesWindow]');
      const settingsWindow = this._settingsWindow();
      const rect = settingsWindow.get_frame_rect();
      if (isOccluded(rect, this)) {
        lg('[UIMainViewer::_adjustPreferencesWindow] isOccluded');
        const cX = (this._activeMonitor.width - rect.width) / 2;
        const cY = (this._activeMonitor.height - rect.height) / 2;
        settingsWindow.move_frame(1, cX, cY);
        this.reset(true /* hard reset */);
        this._imageView._reload();
      }

      function isOccluded(bottom, top) {
        const x = Math.max(bottom.x, top.x);
        const y = Math.max(bottom.y, top.y);
        const width = Math.max(
          0,
          Math.min(bottom.x + bottom.width - 1, top.x + top.width - 1) - x
        );
        const height = Math.max(
          0,
          Math.min(bottom.y + bottom.height - 1, top.y + top.height - 1) - y
        );

        return width >= OCCLUSION_THRESHOLD && height >= OCCLUSION_THRESHOLD;
      }
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
      this._settingsWatchId = this._settings.connect(
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

    _bindConstraints(dir) {
      if (this._bindDir === dir) {
        return;
      }

      const ViewDir = {
        LTR: 0,
        RTL: 1
      };
      const sideParam = {
        [ViewDir.LTR]: {
          imageView: {
            1: {
              from_edge: Clutter.SnapEdge.LEFT,
              to_edge: Clutter.SnapEdge.LEFT
            },
            2: {
              from_edge: Clutter.SnapEdge.RIGHT,
              to_edge: Clutter.SnapEdge.LEFT,
              offset: -20
            }
          },
          swapView: {
            factor: 1.0
          }
        },
        [ViewDir.RTL]: {
          imageView: {
            1: {
              from_edge: Clutter.SnapEdge.RIGHT,
              to_edge: Clutter.SnapEdge.RIGHT
            },
            2: {
              from_edge: Clutter.SnapEdge.LEFT,
              to_edge: Clutter.SnapEdge.RIGHT,
              offset: 20
            }
          },
          swapView: {
            factor: 0.0
          }
        }
      };
      const side = ['left', 'right'];
      const swipe = [St.Side.RIGHT, St.Side.LEFT];
      const thisSide = side[dir];
      const otherSide = side[(dir + 1) % 2];
      const constraints = sideParam[dir];
      lg('[UIMainViewer::_bindConstraints] constraint:', dir);
      this._imageView.remove_constraint_by_name(
        `image-view-snap-${otherSide}-1`
      );
      this._imageView.remove_constraint_by_name(
        `image-view-snap-${otherSide}-2`
      );
      this._imageView.add_constraint_with_name(
        `image-view-snap-${thisSide}-1`,
        new Clutter.SnapConstraint({
          source: this._box,
          ...constraints.imageView[1],
          offset: -this.border_width
        })
      );
      this._imageView.add_constraint_with_name(
        `image-view-snap-${thisSide}-2`,
        new Clutter.SnapConstraint({
          source: this._swapView,
          ...constraints.imageView[2]
        })
      );
      this._swapView.remove_constraint_by_name(`swap-view-align-${otherSide}`);
      this._swapView.add_constraint_with_name(
        `swap-view-align-${thisSide}`,
        new Clutter.AlignConstraint({
          source: this._box,
          align_axis: Clutter.AlignAxis.X_AXIS,
          ...constraints.swapView
        })
      );
      this._dock._slider.swipe = swipe[dir];
      this._updateDockPosition();

      /*
       * Don't bind to the same direction twice.
       */
      this._bindDir = dir;
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
      this._bindConstraints(viewIndex);
      this._moveFloatingButton(viewIndex);

      function getColorSetting(id, settings) {
        let colors = settings.get_strv(id);
        const color = colors
          .map((c, i) => (i < 3 ? c * Constants.FULLY_OPAQUE : c))
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
    }

    _onDestroy() {
      this._close(true);
      if (this._shutter) {
        this._shutter.disconnect(this._shutterClosingHandler);
        this._shutter.disconnect(this._shutterNewShotHandler);
        this._shutter.destroy();
        this._shutter = null;
      }

      this._watcher?.destroy();
      this._dock.destroy();
      this._settings.disconnect(this._settingsWatchId);
      this._unbindShortcuts();
      Main.uiGroup.remove_actor(this._settingsButtonTooltip);
      Main.uiGroup.remove_actor(this._swapButtonTooltip);
      this._settingsButtonTooltip.destroy();
      this._swapButtonTooltip.destroy();

      Main.layoutManager.removeChrome(this);
      global.window_manager.disconnect(this._settingsId);

      this._settingsId = null;
      this._dock = null;
      this._watcher = null;
      this._settings = null;
      this._settingsWatchId = null;
    }

    _showUI() {
      if (this._isActive) return;

      new Timer(this).add(
        300,
        function () {
          this.opacity = 0;
          this.show();
          this.ease({
            opacity: Constants.FULLY_OPAQUE,
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

      const newOpacity = this._isActive ? Constants.FULLY_OPAQUE : 0;
      this.opacity = newOpacity;
      if (!this._isActive) {
        this.show();
        this._dock._show();
      } else {
        this._closeSettings();
      }
      this.ease({
        opacity: Constants.FULLY_OPAQUE - newOpacity,
        duration: 150,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          if (this._isActive) {
            this.hide();
            this._dock._hide();
          }
          this._isActive = !this._isActive;
          lg('[UIMainViewer::_toggleUI]');
        }
      });
    }

    reset(hard = false) {
      this._stopDrag();
      global.display.set_cursor(Meta.Cursor.DEFAULT);

      // Preserve area selection if possible. If the area goes out of bounds,
      // the monitors might have changed, so reset the area.
      const [x, y, w, h] = this._getGeometry();
      // Initially x < 0 will be true so that we can get
      // set the `_activeMonitor` property.
      if (
        hard ||
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

    _updatePosition() {
      const [x, y, ,] = this._getGeometry();
      this.set_position(x, y);
    }

    _updateSize() {
      lg('[UIMainViewer::_updateSize]');
      const [x, y, w, h] = this._getGeometry();
      this._setRect(x, y, w, h);
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
        const [x, y, w, h] = this._getGeometry();
        const [minWidth, minHeight, maxWidth, maxHeight] = [
          INITIAL_WIDTH,
          INITIAL_HEIGHT,
          this._maxXSwing ?? this.width,
          this._maxYSwing ?? this.height
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
      }

      if (isMove) {
        this._updatePosition();
      } else {
        this._updateSize();
        this._updateDockPosition();
      }
      if (this._dragCursor !== Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
        this._imageView._redraw(dx, dy);
      }

      this._dragX += dx;
      this._dragY += dy;
      return Clutter.EVENT_PROPAGATE;
    }

    _shouldHaveFocus() {
      if (this._pointerIsWithin()) {
        return true;
      }
      global.stage.set_key_focus(global.stage);
      return false;
    }

    _pointerIsWithin() {
      const { x, y } = this.getMousePosition();
      lg('[UIMainViewer::_pointerIsWithin] x:', x, 'y:', y);
      return (
        x >= this.x &&
        x < this.x + this.width - 1 &&
        y >= this.y &&
        y < this.x + this.height - 1
      );
    }

    getMousePosition() {
      const display = Display.get_default();
      const seat = display.get_default_seat();
      const pointer = seat.get_pointer();
      const [, x, y] = pointer.get_position();
      return { x, y };
    }

    vfunc_key_press_event(event) {
      if (!this._shouldHaveFocus()) {
        return;
      }
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
      this._imageView._onKeyPress(event);

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

    vfunc_leave_event(event) {
      lg('[UIMainViewer::vfunc_leave_event]');
      global.display.set_cursor(Meta.Cursor.DEFAULT);
      return super.vfunc_leave_event(event);
    }

    vfunc_enter_event(event) {
      lg('[UIMainViewer::vfunc_enter_event]');
      if (!this.has_key_focus()) {
        global.stage.set_key_focus(this);
      }
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
      this._scrollView.connect('scroll-event', this._onScrollEvent.bind(this));

      this._viewBox = new St.Viewport({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: 6
        }),
        y_align: Clutter.ActorAlign.START,
        y_expand: true
      });
      this._scrollView.add_actor(this._viewBox);
      this.connect('destroy', this._onDestroy.bind(this));
    }

    _onScrollEvent(actor, event) {
      this._ensureItemVisibility(null);

      let adjustment,
        delta = 0;
      adjustment = this._scrollView.get_vscroll_bar().get_adjustment();

      let increment = adjustment.step_increment;

      switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
          delta = -increment;
          break;
        case Clutter.ScrollDirection.DOWN:
          delta = +increment;
          break;
        case Clutter.ScrollDirection.SMOOTH: {
          let [, dy] = event.get_scroll_delta();
          delta = dy * increment;
          break;
        }
      }

      const value = adjustment.get_value();

      // TODO: Remove this if possible.
      if (Number.isNaN(value)) {
        adjustment.set_value(delta);
      } else {
        adjustment.set_value(value + delta);
      }

      return Clutter.EVENT_STOP;
    }

    _ensureItemVisibility(actor) {
      if (actor?.hover) {
        const destroyId = actor.connect('destroy', () => {
          this._ensureItemVisibility(null);
          actor.disconnect(destroyId);
        });
        this._ensureActorVisibilityTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          100,
          () => {
            actor.disconnect(destroyId);
            ensureActorVisibleInScrollView(this._scrollView, actor);
            this._ensureActorVisibilityTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }
        );
      } else if (this._ensureActorVisibilityTimeoutId) {
        GLib.source_remove(this._ensureActorVisibilityTimeoutId);
        this._ensureActorVisibilityTimeoutId = 0;
      }
    }

    _onDestroy() {
      if (this._ensureActorVisibilityTimeoutId) {
        GLib.source_remove(this._ensureActorVisibilityTimeoutId);
      }
    }
  }
);

const DNDTracker = GObject.registerClass(
  class DNDTracker extends GObject.Object {
    _init(host, cb) {
      super._init();

      this._isEnabled = false;
      this._cursorMotionCount = 0;
      host.connect('enter-event', () => (this._isEnabled = true));
      host.connect(
        'motion-event',
        () => this._isEnabled && ++this._cursorMotionCount
      );
      host.connect('leave-event', () => {
        this._isEnabled = false;
        if (this._cursorMotionCount >= 3) {
          return;
        }
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

    _addShot(name, shots, gradient, prepend = false) {
      const folder = new UIFolder(name, shots, gradient, {
        style_class: 'pixzzle-ui-folder'
      });
      folder.connect('activate', (widget, params) => {
        this.emit('swap-view', {
          shots: widget._shots,
          date: name,
          ...params
        });
      });
      folder._trigger.connect('notify::hover', (item) => {
        this._ensureItemVisibility(item);
        this._setFocusOnFolder(folder);
      });
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
      lg('[UIFolderViewer::latestShot]');
      if (!this._shotGroups) {
        await this._loadShots();
      }

      const today = fmt(Date.now());
      if (this._shotGroups[today]) {
        return { shots: this._shotGroups[today], date: today };
      }

      lg('[UIFolderViewer::latestShot] shot dates:', this._shotsDate);
      this._clearEmptyGroups();
      const date = this._shotsDate[0];
      if (this._shotGroups[date]) {
        return { shots: this._shotGroups[date], date };
      }
      return { shots: [], date: null };
    }

    async addNewShot(newShot) {
      lg('[UIFolderViewer::addNewShot]', newShot.ocr);
      if (!this._shotGroups) {
        await this._loadShots();
      }

      /*
       * The `nid` property sent via the `activate`
       * signal helps distinguish new screenshots
       * with metadata attached from old shots.
       */
      const today = fmt(Date.now());
      if (!this._shotGroups[today]) {
        lg('[UIFolderViewer::addNewShot] today:', today);
        this._shotGroups[today] = [newShot.name];
        const folder = this._addShot(
          today,
          this._shotGroups[today],
          this._gradients[Math.floor(Math.random() * this._gradients.length)],
          true /* prepend */
        );
        folder.emit('activate', { nid: newShot });
      } else {
        // Insert new shots name at the front to maintain
        // sort ordering.
        this._shotGroups[today].unshift(newShot.name);
        const folder = this._viewBox.get_child_at_index(0);
        folder.emit('activate', { nid: newShot });
      }
    }

    _clearEmptyGroups() {
      for (let i = 0; i < this._shotsDate.length; ) {
        const date = this._shotsDate[i];
        if (!this._shotGroups[date]) {
          delete this._shotGroups[date];
          this._shotsDate.splice(i, 1);
        } else {
          ++i;
        }
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

    _setFocusOn(shotName) {
      const folder = this._findFolderForShot(shotName);
      if (folder != null) {
        ensureActorVisibleInScrollView(this._scrollView, folder._trigger);
        this._setFocusOnFolder(folder);
      }
    }

    _setFocusOnFolder(folder) {
      if (folder == null) {
        const firstDate = this._shotsDate[0];
        firstDate && this._setFocusOnFolder(this._folders[firstDate]);
        return;
      }
      const allFolders = Object.values(this._folders);
      allFolders
        .filter((folder) => !folder.get_effect('focus-effect'))
        .forEach((folder) => folder._addFocusEffect());
      folder._removeFocusEffect();
    }

    _setFocusOnCurrentFolder() {
      const allFolders = Object.values(this._folders);
      const folder = allFolders.find(
        (folder) => !folder.get_effect('focus-effect')
      );
      if (folder) {
        this._setFocusOnFolder(folder);
        ensureActorVisibleInScrollView(this._scrollView, folder._trigger);
      }
    }

    _findFolderForShot(name) {
      const folders = Object.values(this._folders);
      return folders.find((folder) => folder._shots.indexOf(name) !== -1);
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
      }
    }
  },
  class UIFolder extends St.Widget {
    _init(name, shots, gradient, params) {
      super._init({
        name,
        ...params,
        reactive: true,
        layout_manager: new Clutter.BinLayout()
      });

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

    _addFocusEffect() {
      const focusEffect = new Shell.BlurEffect({
        brightness: Constants.FULLY_OPAQUE,
        mode: Shell.BlurMode.ACTOR,
        sigma: 5
      });
      this.add_effect_with_name('focus-effect', focusEffect);
    }

    _removeFocusEffect() {
      this.remove_effect_by_name('focus-effect');
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
      ),
      sibling: GObject.ParamSpec.object(
        'sibling',
        'sibling',
        'sibling',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        UIFolderViewer.$gtype
      )
    }
  },
  class UIThumbnailViewer extends UISideViewBase {
    _init(params) {
      super._init(params);
    }

    _initialize(payload, onComplete) {
      if (!this._initialized) {
        this._loadShots(payload)
          .then((shots) => {
            this.emit('replace', shots[0] ?? {});
            onComplete?.();
            this._initialized = true;
            this.notify('loaded');
          })
          .catch((err) => logError(err, 'Unable to load previous state'));
      }
    }

    reload(shots, cb) {
      this._initialized = false;
      this._initialize(shots, cb);
    }

    _addShot(newShot, prepend) {
      const shot = new UIPreview(newShot, this.width);
      shot.connect('activate', (widget) => {
        this.emit('replace', { name: widget._filename, widget: shot });
      });
      shot.connect('delete', (widget, params) => {
        const { permanently } = params;
        if (permanently) {
          this._confirmDelete(() => removeShot.bind(this)(permanently));
        } else {
          removeShot.bind(this)(permanently);
        }
      });
      shot._trigger.connect('notify::hover', (item) => {
        this._ensureItemVisibility(item);
      });
      if (prepend) {
        this._viewBox.insert_child_at_index(shot, 0);
      } else {
        this._viewBox.add_child(shot);
      }

      function removeShot(permanently) {
        this._removeShot(shot).then((filename) => {
          const nextShot = this._viewBox.get_child_at_index(0);
          lg(
            '[UIThumbnailViewer::_addShot::removeShot] nextShot:',
            nextShot?._filename
          );
          this.emit('replace', {
            name: nextShot?._filename ?? null,
            widget: nextShot
          });
          const name = GLib.path_get_basename(filename);
          const thumbnail = GLib.build_filenamev([
            getThumbnailsLocation().get_path(),
            name
          ]);

          if (permanently) {
            GLib.unlink(filename);
            GLib.unlink(thumbnail);
          }
          this.sibling.removeShot(this._date, filename);

          if (!nextShot) {
            this.reload();
          }
        });
      }

      return { name: shot._filename, widget: shot };
    }

    _addNewShot(newShot) {
      const shot = this._addShot(newShot.name, true /* prepend */);
      this.emit('replace', { ...newShot, ...shot });
    }

    _confirmDelete(cb) {
      Dialog.getDialog().display(
        {
          icon: {
            icon_name: 'pixzzle-ui-warning-sprite.png',
            animatable: true,
            system_icon: false,
            size: 36,
            rate: 36
          },
          header: 'Warning',
          prompt: 'Are you sure you want to delete picture permanently?',
          tips:
            '<b>Tip</b>: Press the <i><b>delete</b></i> key to temporarily ' +
            'delete picture',
          ok: 'Yes',
          cancel: 'No'
        },
        (status) => {
          if (status === Dialog.ModalReply.OKAY) {
            cb();
          }
        }
      );
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
      ensureActorVisibleInScrollView(this._scrollView, shots[next]);
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
            /*
             * Notify the viewBox that we have removed
             * a child and redraw.
             */
            this._viewBox.queue_relayout();
            resolve(file);
          }
        });
      });
    }

    async _loadShots(payload) {
      this._viewBox.destroy_all_children();
      const bundle = payload ?? (await this.sibling.latestShot());
      lg('[UIThumbnailViewer::_loadShots]', 'payload:', bundle.shots.length);
      this._is_flat = bundle.is_flat;
      this._date = bundle.date;
      const shots = [];
      for (const shot of bundle.shots) {
        shots.push(this._addShot(shot));
      }
      const newShotProps = bundle.nid;
      if (newShotProps) {
        this.emit('replace', { ...newShotProps, ...shots[0] });
      }

      return shots;
    }

    get loading() {
      return !this._initialized;
    }
  }
);

const UIPreview = GObject.registerClass(
  {
    GTypeName: 'UIPreview',
    Signals: { activate: {}, delete: { param_types: [Object.prototype] } }
  },
  class UIPreview extends St.Widget {
    _init(filename, span, params) {
      super._init({ ...params, y_expand: false, reactive: true });

      this._surface = new St.Widget({ x_expand: false, y_expand: false });
      this.add_child(this._surface);

      const [thumbnail, actualFile] = this._getThumbnail(filename);
      let pixbuf;
      if (!thumbnail) {
        const baseBuf = GdkPixbuf.Pixbuf.new_from_file(filename);
        if (span > baseBuf.get_width() || span > baseBuf.get_height()) {
          const aspectRatio = baseBuf.get_width() / baseBuf.get_height();
          const scaledHeight = Math.max((span * 1.0) / aspectRatio, span);
          pixbuf = baseBuf
            .scale_simple(span, scaledHeight, GdkPixbuf.InterpType.BILINEAR)
            .new_subpixbuf(0, 0, span - 1, span - 1);
          pixbuf.set_option(TINY_IMAGE, 'true');
        } else {
          pixbuf = baseBuf.new_subpixbuf(0, 0, span - 1, span - 1);
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
            brightness: Constants.FULLY_OPAQUE,
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
        this.emit('delete', {});
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
