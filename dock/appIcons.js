/* appIcons.js
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
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Me = imports.misc.extensionUtils.getCurrentExtension();

const AppDisplay = Me.imports.dock.appDisplay;
const BoxPointer = imports.ui.boxpointer;
const Dash = Me.imports.dock.dash_base;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

const ExtensionUtils = imports.misc.extensionUtils;
const Docking = Me.imports.dock.docking;
const Utils = Me.imports.dock.utils;

var DockAbstractAppIcon = GObject.registerClass(
  {
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
  },
  class DockAbstractAppIcon extends Dash.DashIcon {
    // settings are required inside.
    _init(app) {
      super._init(app);
    }

    shouldShowTooltip() {
      return this.hover;
    }
  },
);

var DockAppIcon = GObject.registerClass(
  {},
  class DockAppIcon extends DockAbstractAppIcon {
    _init(app) {
      super._init(app);
    }
  },
);

function makeAppIcon(app) {
  return new DockAppIcon(app);
}

/**
 * This function is used for both extendShowAppsIcon and extendDashItemContainer
 */
function itemShowLabel() {
  // Check if the label is still present at all. When switching workpaces, the
  // item migt have been destroyed in between.
  if (!this._labelText || this.label.get_stage() == null) return;

  this.label.set_text(this._labelText);
  this.label.opacity = 0;
  this.label.show();

  let [stageX, stageY] = this.get_transformed_position();
  let node = this.label.get_theme_node();

  let itemWidth = this.allocation.x2 - this.allocation.x1;
  let itemHeight = this.allocation.y2 - this.allocation.y1;

  let labelWidth = this.label.get_width();
  let labelHeight = this.label.get_height();

  let x, y, xOffset, yOffset;

  let position = Utils.getPosition();
  this._isHorizontal = position == St.Side.TOP || position == St.Side.BOTTOM;
  let labelOffset = node.get_length("-x-offset");

  switch (position) {
    case St.Side.LEFT:
      yOffset = Math.floor((itemHeight - labelHeight) / 2);
      y = stageY + yOffset;
      xOffset = labelOffset;
      x = stageX + this.get_width() + xOffset;
      break;
    case St.Side.RIGHT:
      yOffset = Math.floor((itemHeight - labelHeight) / 2);
      y = stageY + yOffset;
      xOffset = labelOffset;
      x = Math.round(stageX) - labelWidth - xOffset;
      break;
    case St.Side.TOP:
      y = stageY + labelOffset + itemHeight;
      xOffset = Math.floor((itemWidth - labelWidth) / 2);
      x = stageX + xOffset;
      break;
    case St.Side.BOTTOM:
      yOffset = labelOffset;
      y = stageY - labelHeight - yOffset;
      xOffset = Math.floor((itemWidth - labelWidth) / 2);
      x = stageX + xOffset;
      break;
  }

  // keep the label inside the screen border
  // Only needed fot the x coordinate.

  // Leave a few pixel gap
  let gap = 5;
  let monitor = Main.layoutManager.findMonitorForActor(this);
  if (x - monitor.x < gap) x += monitor.x - x + labelOffset;
  else if (x + labelWidth > monitor.x + monitor.width - gap)
    x -= x + labelWidth - (monitor.x + monitor.width) + gap;

  this.label.remove_all_transitions();
  this.label.set_position(x, y);
  this.label.ease({
    opacity: 255,
    duration: Dash.DASH_ITEM_LABEL_SHOW_TIME,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
  });
}
