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
  GdkPixbuf
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
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
const _ = Gettext.domain('pixzzle').gettext;

const { inflateSettings, SCHEMA_NAME, lg, SHOT_STORE, THUMBNAIL_STORE } =
  Me.imports.utils;
const { UIShutter } = Me.imports.screenshot;
const { computePanelPosition } = Me.imports.panel;
const Panel = computePanelPosition();
const Prefs = Me.imports.prefs;

const INITIAL_WIDTH = 500;
const INITIAL_HEIGHT = 600;
const ALLOWANCE = 80;
const EDGE_THRESHOLD = 2;
const FULLY_OPAQUE = 255;
/*
 * Store metadata in image ancillary chunk
 * to detect if the image is smaller than
 * the size of thumbnail view. This kinds
 * of images are blurred to reduce pixellation.
 */
const TINY_IMAGE = 'tINy';

let SETTING_DISABLE_TILE_MODE;
let SETTING_NATURAL_PANNING;

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

      Main.layoutManager.addTopChrome(this);

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
        x_expand: true
      });
      this._topMostContainer.add_child(this._splitViewXContainer);

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

      this._settingsButton = new St.Button({
        style_class: 'pixzzle-ui-settings-button',
        label: 'settings',
        child: new St.Icon({ icon_name: 'org.gnome.Settings-symbolic' }),
        x_expand: false,
        reactive: true,
        x_align: Clutter.ActorAlign.CENTER,
        rotation_angle_z: 0
      });
      this._buttonBox.add_child(this._settingsButton);
      this._settingsButton.set_pivot_point(0.5, 0.5);
      this._settingsButton.connect('notify::hover', () => {
        this._animateSettings();
      });
      this._settingsButton.connect('clicked', () => {
        this._openSettings();
      });
      this._settingsButton.connect('enter-event', this._stopDrag.bind(this));

      this._screenshotButton = new St.Button({
        style_class: 'pixzzle-ui-screenshot-button',
        label: _('Add New'),
        x_expand: false,
        x_align: Clutter.ActorAlign.END
      });
      this._buttonBox.add_child(this._screenshotButton);
      this._screenshotButton.connect('clicked', () =>
        this._showScreenshotView()
      );
      this._screenshotButton.connect('enter-event', this._stopDrag.bind(this));

      this._thumbnailView = new UIThumbnailViewer({
        name: 'UIThumbnailViewer',
        x_expand: false
      });
      this._thumbnailView.connect('replace', (_, filename) => {
        this._imageViewer._replace(filename);
        this._emptyView = this._thumbnailView._shotCount() == 0;
      });
      this._thumbnailView.connect('enter-event', this._stopDrag.bind(this));

      this._splitViewXContainer.add_child(this._bigViewContainer);
      this._splitViewXContainer.add_child(this._thumbnailView);

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
        this._animateSettings();
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
          (_, shotName) => {
            this._thumbnailView._addNewShot(shotName);
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

      if (typeof ExtensionUtils.openPrefs === 'function') {
        ExtensionUtils.openPrefs();
      } else {
        Util.spawn(['gnome-shell-extension-prefs', Me.uuid]);
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
    }

    _bindShortcuts() {
      this._unbindShortcuts();

      this._bindShortcut(
        Prefs.Fields.TOGGLE_VISIBILITY,
        this._toggleUI.bind(this)
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

    _close() {
      this.remove_all_transitions();
      global.display.set_cursor(Meta.Cursor.DEFAULT);
      if (this._dragButton) {
        this._stopDrag();
      }
      this._isActive = false;
      this._closeSettings();
      this.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: this.hide.bind(this)
      });
      this._snapIndicator.hide();
    }

    _onDestroy() {
      if (this._shutter) {
        this._shutter.disconnect(this._shutterClosingHandler);
        this._shutter.disconnect(this._shutterNewShotHandler);
        this._shutter.destroy();
        this._shutter = null;
      }

      if (this._showTimeoutId) {
        GLib.Source.remove(this._showTimeoutId);
        this._showTimeoutId = null;
      }

      Main.layoutManager.removeChrome(this._snapIndicator);
      Main.layoutManager.removeChrome(this);
      this._unbindShortcuts();
    }

    _showUI() {
      if (this._isActive) return;

      this._showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this.opacity = 0;
        this.show();
        this.ease({
          opacity: 255,
          duration: 150,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        lg('[UIMainViewer::_showUI]');
        this._showTimeoutId = null;
        this._isActive = true;
        return GLib.SOURCE_REMOVE;
      });
      GLib.Source.set_name_by_id(
        this._showTimeoutId,
        '[gnome-shell] UiMainViewer._showUI'
      );
    }

    _toggleUI() {
      this._toggleTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        300,
        () => {
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
            }
          });

          lg('[UIMainViewer::_toggleUI]');
          this._toggleTimeoutId = null;
          return GLib.SOURCE_REMOVE;
        }
      );
      GLib.Source.set_name_by_id(
        this._toggleTimeoutId,
        '[gnome-shell] UiMainViewer._toggleUI'
      );
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
          if (!this._isInRestrictedArea(x, y, leftX, topY, rightX, bottomY)) {
            lg(desc, 'MOVE_OR_RESIZE');
            return Meta.Cursor.MOVE_OR_RESIZE_WINDOW;
          }
        }
      }

      return Meta.Cursor.DEFAULT;
    }

    _isInRestrictedArea(x, y, leftX, topY, rightX, bottomY) {
      const offset = this.border_width;
      const spacing = this._topMostContainer.spacing;
      const buttonBoxSpacing = this._buttonBox.spacing;

      const shotWidth = this._screenshotButton.width;
      const shotHeight = this._screenshotButton.height;
      const shotX = rightX - offset - shotWidth;
      const shotY = bottomY - offset - shotHeight;
      const shotMargin = offset + spacing + shotHeight;

      const settingsWidth = this._settingsButton.width;
      const settingsHeight = this._settingsButton.height;
      const settingsX = shotX - buttonBoxSpacing - settingsWidth;
      const settingsY = shotY;

      return !(
        x - leftX < offset ||
        rightX - x < offset ||
        y - topY < offset ||
        (bottomY - y < shotMargin &&
          (x < shotX ||
            y < shotY ||
            x > shotX + shotWidth ||
            y > shotY + shotHeight) &&
          (x < settingsX ||
            y < settingsY ||
            x > settingsX + settingsWidth ||
            y > settingsY + settingsWidth))
      );
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
      if (this._startX < Panel.Left.width) {
        overshootX = Panel.Left.width - this._startX;
        this._startX += overshootX;
        this._lastX += overshootX * isMove;
        dx -= overshootX;
      } else if (this._lastX >= monitorWidth - Panel.Right.width) {
        overshootX = monitorWidth - Panel.Right.width - this._lastX;
        this._startX += overshootX * isMove;
        this._lastX += overshootX;
        dx -= overshootX;
      }

      if (this._startY < Panel.Top.height) {
        overshootY = Panel.Top.height - this._startY;
        this._startY += overshootY;
        this._lastY += overshootY * isMove;
        dy -= overshootY;
      } else if (this._lastY >= monitorHeight - Panel.Bottom.height) {
        overshootY = monitorHeight - Panel.Bottom.height - this._lastY;
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
const N_AXIS = 4;

const UIImageRenderer = GObject.registerClass(
  {
    Signals: {
      'lock-axis': { param_types: [Object.prototype] },
      'clean-slate': {}
    }
  },
  class UIImageRenderer extends St.Widget {
    _init(topParent, params) {
      super._init({ ...params, reactive: true, can_focus: true });

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
        } else if (this._filename) {
          context.save();
          context.setOperator(Cairo.Operator.CLEAR);
          context.paint();
          this._filename = null;
        }
      });
    }

    _redraw(deltaX, deltaY) {
      if (this._filename) {
        const [width, height] = this._topParent._computeBigViewSize();
        this._render(deltaX, deltaY, width, height);
      } else {
        this._isPanningEnabled = false;
      }
    }

    _replace(newFile) {
      lg('[UIImageRenderer::_replace]', 'newFile:', newFile);
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

    _copyToClipboard(pixbuf, message) {
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

    _onKeyPress(event) {
      const symbol = event.keyval;
      if (event.modifier_state & Clutter.ModifierType.CONTROL_MASK) {
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
            this._copyToClipboard(
              this._visibleRegionPixbuf,
              'Viewport yanked!'
            );
          } else {
            this._copyToClipboard(this._pixbuf, 'Image yanked!');
          }
        }
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
      global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);

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
      if (!this._dragButton || !this._isPanningEnabled) {
        return Clutter.EVENT_PROPAGATE;
      }

      let dx = Math.round(x - this._dragX);
      let dy = Math.round(y - this._dragY);

      const [maxWidth, maxHeight] = [
        this._pixbuf.get_width(),
        this._pixbuf.get_height()
      ];

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

const UIThumbnailViewer = GObject.registerClass(
  {
    GTypeName: 'UIThumbnailViewer',
    Signals: { replace: { param_types: [GObject.TYPE_STRING] } }
  },
  class UIThumbnailViewer extends St.BoxLayout {
    _init(params) {
      super._init({ ...params, y_expand: true });

      this._scrollView = new St.ScrollView({
        style_class: 'pixzzle-ui-thumbnail-scrollview',
        hscrollbar_policy: St.PolicyType.EXTERNAL,
        vscrollbar_policy: St.PolicyType.EXTERNAL,
        enable_mouse_scrolling: true,
        y_expand: true
      });
      this.add_child(this._scrollView);
      this._scrollView.set_overlay_scrollbars(false);

      this._viewBox = new St.Viewport({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: 6
        }),
        y_align: Clutter.ActorAlign.START
      });
      this._scrollView.add_actor(this._viewBox);

      this._connector = this.connect('notify::mapped', () => {
        lg('[UIThumbnailViewer::_init::notify::mapped]');
        if (!this._initialized) {
          this._loadShots()
            .then((allShots) => {
              this.emit('replace', allShots[0] ?? null);
              this.disconnect(this._connector);
            })
            .catch((err) => logError(err, 'Unable to load previous state'));
        } else {
          this._initialized = true;
        }
      });
    }

    _addShot(newShot, prepend) {
      const shot = new UIPreview(newShot, this.width);
      shot.connect('activate', (widget) => {
        lg('UIThumbnailViewer::_addShot::shot::activate]', widget);
        this.emit('replace', widget._filename);
      });
      shot.connect('delete', (widget) => {
        this._removeShot(widget).then((filename) => {
          const nextShot = this._viewBox.get_child_at_index(0);
          this.emit('replace', nextShot?._filename ?? null);
          GLib.unlink(filename);
        });
      });
      if (prepend) {
        this._viewBox.insert_child_at_index(shot, 0);
      } else {
        this._viewBox.add_child(shot);
      }
    }

    _addNewShot(newShot) {
      this._addShot(newShot, true /* prepend */);
      this.emit('replace', newShot);
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

    async _loadShots() {
      let snapshotDir = SHOT_STORE;
      if (!snapshotDir.query_exists(null)) {
        return;
      }

      const allShots = await this._processShots(snapshotDir);
      for (const shot of allShots) {
        this._addShot(shot);
      }

      return allShots;
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

      function filesDateSorter(one, other) {
        const oneDate = getDate(one);
        const otherDate = getDate(other);
        return oneDate > otherDate ? -1 : oneDate < otherDate ? 1 : 0;
      }

      function getDate(fullname) {
        const name = GLib.path_get_basename(fullname);
        const uuid = GLib.uuid_string_random().length + 1;
        const effective = name.slice(uuid, name.indexOf('.'));
        const parts = effective.match(/(\d+-\d+-\d+)-(\d+-\d+-\d+)/);
        const [date, time] = [parts[1], parts[2].replaceAll('-', ':')];
        return Date.parse(date + ' ' + time);
      }
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
            brightness: 255,
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

      this._trigger = new St.Button({
        style_class: 'pixzzle-ui-thumbnail-trigger'
      });
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
      const dir = THUMBNAIL_STORE;
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
  }
);
