/* appDisplay.js
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

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Graphene = imports.gi.Graphene;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Params = imports.misc.params;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const lg = Me.imports.utils.lg;

const APP_ICON_SCALE_IN_TIME = 500;
const APP_ICON_SCALE_IN_DELAY = 700;

const APP_ICON_TITLE_EXPAND_TIME = 200;
const APP_ICON_TITLE_COLLAPSE_TIME = 100;

var AppViewItem = GObject.registerClass(
  class AppViewItem extends St.Button {
    _init(params = {}, isDraggable = true, expandTitleOnHover = true) {
      super._init({
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        reactive: true,
        button_mask: St.ButtonMask.ONE,
        can_focus: true,
        ...params
      });

      this._otherIconIsHovering = false;
      this._expandTitleOnHover = expandTitleOnHover;

      if (expandTitleOnHover)
        this.connect('notify::hover', this._onHover.bind(this));
    }

    _updateMultiline() {
      if (!this._expandTitleOnHover || !this.icon.label) return;

      const { label } = this.icon;
      const { clutterText } = label;
      const layout = clutterText.get_layout();
      if (!layout.is_wrapped() && !layout.is_ellipsized()) return;

      label.remove_transition('allocation');

      const id = label.connect('notify::allocation', () => {
        label.restore_easing_state();
        label.disconnect(id);
      });

      const expand =
        this._forcedHighlight || this.hover || this.has_key_focus();
      label.save_easing_state();
      label.set_easing_duration(
        expand ? APP_ICON_TITLE_EXPAND_TIME : APP_ICON_TITLE_COLLAPSE_TIME
      );
      clutterText.set({
        line_wrap: expand,
        line_wrap_mode: expand ? Pango.WrapMode.WORD_CHAR : Pango.WrapMode.NONE,
        ellipsize: expand ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END
      });
    }

    _onHover() {
      this._updateMultiline();
    }

    scaleIn() {
      this.scale_x = 0;
      this.scale_y = 0;

      this.ease({
        scale_x: 1,
        scale_y: 1,
        duration: APP_ICON_SCALE_IN_TIME,
        delay: APP_ICON_SCALE_IN_DELAY,
        mode: Clutter.AnimationMode.EASE_OUT_QUINT
      });
    }

    scaleAndFade() {
      this.reactive = false;
      this.ease({
        scale_x: 0.5,
        scale_y: 0.5,
        opacity: 0
      });
    }

    undoScaleAndFade() {
      this.reactive = true;
      this.ease({
        scale_x: 1.0,
        scale_y: 1.0,
        opacity: 255
      });
    }

    _withinLeeways(x) {
      return (
        x < IconGrid.LEFT_DIVIDER_LEEWAY ||
        x > this.width - IconGrid.RIGHT_DIVIDER_LEEWAY
      );
    }

    vfunc_key_focus_in() {
      this._updateMultiline();
      super.vfunc_key_focus_in();
    }

    vfunc_key_focus_out() {
      this._updateMultiline();
      super.vfunc_key_focus_out();
    }

    get id() {
      return this._id;
    }

    get name() {
      return this._name;
    }

    setForcedHighlight(highlighted) {
      this._forcedHighlight = highlighted;
      this.set({
        track_hover: !highlighted,
        hover: highlighted
      });
    }
  }
);

var AppIcon = GObject.registerClass(
  {
    Signals: {
      'sync-tooltip': {}
    }
  },
  class AppIcon extends AppViewItem {
    _init(app, iconParams = {}) {
      // Get the isDraggable property without passing it on to the BaseIcon:
      const appIconParams = Params.parse(
        iconParams,
        { isDraggable: true },
        true
      );
      const isDraggable = appIconParams['isDraggable'];
      delete iconParams['isDraggable'];
      const expandTitleOnHover = appIconParams['expandTitleOnHover'];
      delete iconParams['expandTitleOnHover'];

      super._init(
        { style_class: 'app-well-app' },
        isDraggable,
        expandTitleOnHover
      );

      this._iconParams = iconParams;

      this._iconContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true
      });
      this.set_child(this._iconContainer);

      this._setUpApp(app, iconParams);
      this.connect('destroy', this._onDestroy.bind(this));
    }

    _createIcon(iconSize) {
      return this.app.get_icon(iconSize);
    }

    _replaceApp(app) {
      const iconParams = {};
      this._iconContainer.remove_child(this.icon);
      this.icon.destroy();
      this._setUpApp(app, this._iconParams);
    }

    _setUpApp(app, iconParams) {
      this.app = app;
      this._name = app.get_name();
      iconParams['createIcon'] = this._createIcon.bind(this);
      iconParams['setSizeManually'] = true;
      this.icon = new IconGrid.BaseIcon(app.get_name(), iconParams);
      this._iconContainer.add_child(this.icon);
      this.label_actor = this.icon.label;
    }

    _onDestroy() {
      lg('[AppIcon::_onDestroy]');
      this.app.destroy();
      this._iconParams = null;
      this.app = null;
    }

    vfunc_leave_event(event) {
      const ret = super.vfunc_leave_event(event);

      this.fake_release();
      return ret;
    }

    vfunc_clicked(button) {
      this.activate(button);
    }

    activate(button) {
      this.app.click(button);
    }

    shouldShowTooltip() {
      return this.hover;
    }
  }
);
