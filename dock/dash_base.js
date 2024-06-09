/* dash_base.js
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
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Graphene = imports.gi.Graphene;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const AppDisplay = Me.imports.dock.appDisplay;
const Main = imports.ui.main;

var DASH_ANIMATION_TIME = 200;
var DASH_ITEM_LABEL_SHOW_TIME = 150;
var DASH_ITEM_LABEL_HIDE_TIME = 100;
var DASH_ITEM_HOVER_TIMEOUT = 300;

var DashIcon = GObject.registerClass(
  class DashIcon extends AppDisplay.AppIcon {
    _init(app) {
      super._init(app, {
        setSizeManually: true,
        showLabel: false
      });
    }

    scaleAndFade() {}

    undoScaleAndFade() {}
  }
);

// A container like StBin, but taking the child's scale into account
// when requesting a size
var DashItemContainer = GObject.registerClass(
  class DashItemContainer extends St.Widget {
    _init() {
      super._init({
        style_class: 'dash-item-container',
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        layout_manager: new Clutter.BinLayout(),
        scale_x: 0,
        scale_y: 0,
        opacity: 0,
        x_expand: false,
        x_align: Clutter.ActorAlign.CENTER
      });

      this._labelText = '';
      this.label = new St.Label({ style_class: 'dash-label' });
      this.label.hide();
      Main.layoutManager.addChrome(this.label);
      this.label.connectObject('destroy', () => (this.label = null), this);
      this.label_actor = this.label;

      this.child = null;
      this.animatingOut = false;

      this.connect('notify::scale-x', () => this.queue_relayout());
      this.connect('notify::scale-y', () => this.queue_relayout());

      this.connect('destroy', () => {
        this.removeChild();
        Main.layoutManager.removeChrome(this.label);
        this.label?.destroy();
      });
    }

    vfunc_get_preferred_height(forWidth) {
      let themeNode = this.get_theme_node();
      forWidth = themeNode.adjust_for_width(forWidth);
      let [minHeight, natHeight] = super.vfunc_get_preferred_height(forWidth);
      return themeNode.adjust_preferred_height(
        minHeight * this.scale_y,
        natHeight * this.scale_y
      );
    }

    vfunc_get_preferred_width(forHeight) {
      let themeNode = this.get_theme_node();
      forHeight = themeNode.adjust_for_height(forHeight);
      let [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight);
      return themeNode.adjust_preferred_width(
        minWidth * this.scale_x,
        natWidth * this.scale_x
      );
    }

    showLabel() {
      if (!this._labelText) return;

      this.label.set_text(this._labelText);
      this.label.opacity = 0;
      this.label.show();

      let [stageX, stageY] = this.get_transformed_position();

      const itemWidth = this.allocation.get_width();

      const labelWidth = this.label.get_width();
      const xOffset = Math.floor((itemWidth - labelWidth) / 2);
      const x = Math.clamp(
        stageX + xOffset,
        0,
        global.stage.width - labelWidth
      );

      let node = this.label.get_theme_node();
      const yOffset = node.get_length('-y-offset');

      const y = stageY - this.label.height - yOffset;

      this.label.set_position(x, y);
      this.label.ease({
        opacity: 255,
        duration: DASH_ITEM_LABEL_SHOW_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    }

    setLabelText(text) {
      this._labelText = text;
      this.child.accessible_name = text;
    }

    hideLabel() {
      this.label.ease({
        opacity: 0,
        duration: DASH_ITEM_LABEL_HIDE_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.label.hide()
      });
    }

    setChild(actor) {
      if (this.child === actor) return;

      this.destroy_all_children();

      this.child = actor;
      this.child.y_expand = false;
      this.add_child(this.child);
    }

    removeChild() {
      this.child.destroy_all_children();
      this.destroy_all_children();
      this.child = null;
    }

    show(animate) {
      if (this.child == null) return;

      let time = animate ? DASH_ANIMATION_TIME : 0;
      this.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: time,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    }

    animateOutAndDestroy() {
      this.label.hide();

      if (this.child == null) {
        this.destroy();
        return;
      }

      this.animatingOut = true;
      this.ease({
        scale_x: 0,
        scale_y: 0,
        opacity: 0,
        duration: DASH_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.destroy()
      });
    }
  }
);

var DashIconsLayout = GObject.registerClass(
  class DashIconsLayout extends Clutter.BoxLayout {
    _init() {
      super._init({
        orientation: Clutter.Orientation.HORIZONTAL
      });
    }

    vfunc_get_preferred_width(container, forHeight) {
      const [, natWidth] = super.vfunc_get_preferred_width(
        container,
        forHeight
      );
      return [0, natWidth];
    }
  }
);

var Dash = GObject.registerClass(
  {
    Signals: { 'icon-size-changed': {} }
  },
  class Dash extends St.Widget {
    _init() {
      this._showLabelTimeoutId = 0;
      this._resetHoverTimeoutId = 0;
      this._labelShowing = false;

      super._init({
        name: 'dash'
      });

      this.connect('destroy', this._onDestroy.bind(this));
    }

    _hookUpLabel(item, appIcon) {
      item.child.connect('notify::hover', () => {
        this._syncLabel(item, appIcon);
      });

      item.child.connect('clicked', () => {
        this._labelShowing = false;
        item.hideLabel();
      });

      if (appIcon) {
        appIcon.connect('sync-tooltip', () => {
          this._syncLabel(item, appIcon);
        });
      }
    }

    _syncLabel(item, appIcon) {
      let shouldShow = appIcon
        ? appIcon.shouldShowTooltip()
        : item.child.get_hover();

      if (shouldShow) {
        if (this._showLabelTimeoutId === 0) {
          let timeout = this._labelShowing ? 0 : DASH_ITEM_HOVER_TIMEOUT;
          this._showLabelTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            timeout,
            () => {
              this._labelShowing = true;
              item.showLabel();
              this._showLabelTimeoutId = 0;
              return GLib.SOURCE_REMOVE;
            }
          );
          GLib.Source.set_name_by_id(
            this._showLabelTimeoutId,
            '[gnome-shell] item.showLabel'
          );
          if (this._resetHoverTimeoutId > 0) {
            GLib.source_remove(this._resetHoverTimeoutId);
            this._resetHoverTimeoutId = 0;
          }
        }
      } else {
        if (this._showLabelTimeoutId > 0)
          GLib.source_remove(this._showLabelTimeoutId);
        this._showLabelTimeoutId = 0;
        item.hideLabel();
        if (this._labelShowing) {
          this._resetHoverTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DASH_ITEM_HOVER_TIMEOUT,
            () => {
              this._labelShowing = false;
              this._resetHoverTimeoutId = 0;
              return GLib.SOURCE_REMOVE;
            }
          );
          GLib.Source.set_name_by_id(
            this._resetHoverTimeoutId,
            '[gnome-shell] this._labelShowing'
          );
        }
      }
    }

    _onDestroy() {
      if (this._resetHoverTimeoutId) {
        GLib.source_remove(this._resetHoverTimeoutId);
      }
      if (this._showLabelTimeoutId) {
        GLib.source_remove(this._showLabelTimeoutId);
      }
    }
  }
);
