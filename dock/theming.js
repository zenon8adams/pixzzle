/* theming.js
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

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Signals = imports.signals;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const AppDisplay = imports.ui.appDisplay;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Docking = Me.imports.dock.docking;
const Utils = Me.imports.dock.utils;

/*
 * DEFAULT:  transparency given by theme
 * FIXED:    constant transparency chosen by user
 * DYNAMIC:  apply 'transparent' style when no windows are close to the dock
 * */
const TransparencyMode = {
  DEFAULT: 0,
  FIXED: 1,
  DYNAMIC: 3,
};

/**
 * Manage theme customization and custom theme support
 */
var ThemeManager = class DashToDock_ThemeManager {
  constructor(dock) {
    this._signalsHandler = new Utils.GlobalSignalsHandler(this);
    this._actor = dock;
    this._dash = dock.dash;

    // initialize colors with generic values
    this._customizedBackground = { red: 0, green: 0, blue: 0, alpha: 0 };
    this._customizedBorder = { red: 0, green: 0, blue: 0, alpha: 0 };
    this._transparency = new Transparency(dock);

    this._updateCustomStyleClasses();

    // destroy themeManager when the managed actor is destroyed (e.g. extension unload)
    // in order to disconnect signals
    this._signalsHandler.add(this._actor, "destroy", () => this.destroy());
  }

  destroy() {
    this.emit("destroy");
    this._transparency.destroy();
    this._destroyed = true;
  }

  _onOverviewShowing() {
    this._actor.add_style_pseudo_class("overview");
  }

  _onOverviewHiding() {
    this._actor.remove_style_pseudo_class("overview");
  }

  _updateCustomStyleClasses() {
    this._actor.add_style_class_name("running-dots");
  }

  updateCustomTheme() {
    if (this._destroyed)
      throw new Error(
        `Impossible to update a destroyed ${this.constructor.name}`,
      );
    this._updateCustomStyleClasses();
    this.emit("updated");
  }
};
Signals.addSignalMethods(ThemeManager.prototype);

var Transparency = class DashToDock_Transparency {
  constructor(dock) {
    this._dash = dock.dash;
    this._actor = this._dash._container;
    this._backgroundActor = this._dash._background;
    this._dockActor = dock;
    this._dock = dock;
    this._panel = Main.panel;
    this._position = Utils.getPosition();

    // All these properties are replaced with the ones in the .dummy-opaque and .dummy-transparent css classes
    this._backgroundColor = "0,0,0";
    this._transparentAlpha = "0.2";
    this._opaqueAlpha = "1";
    this._transparentAlphaBorder = "0.1";
    this._opaqueAlphaBorder = "0.5";
    this._transparentTransition = "0ms";
    this._opaqueTransition = "0ms";
    this._base_actor_style = "";
  }

  enable() {
    this.disable();

    this._base_actor_style = this._actor.get_style();
    if (this._base_actor_style == null) {
      this._base_actor_style = "";
    }

    this._updateStyles();

    this.emit("transparency-enabled");
  }

  disable() {
    this.emit("transparency-disabled");
  }

  destroy() {
    this.disable();
  }

  _updateStyles() {
    this._transparent_style =
      this._base_actor_style +
      "background-color: rgba(" +
      this._backgroundColor +
      ", " +
      this._transparentAlpha +
      ");" +
      "border-color: rgba(" +
      this._backgroundColor +
      ", " +
      this._transparentAlphaBorder +
      ");" +
      "transition-duration: " +
      this._transparentTransition +
      "ms;";

    this._opaque_style =
      this._base_actor_style +
      "background-color: rgba(" +
      this._backgroundColor +
      ", " +
      this._opaqueAlpha +
      ");" +
      "border-color: rgba(" +
      this._backgroundColor +
      "," +
      this._opaqueAlphaBorder +
      ");" +
      "transition-duration: " +
      this._opaqueTransition +
      "ms;";

    this.emit("styles-updated");
  }

  setColor(color) {
    this._backgroundColor = color.red + "," + color.green + "," + color.blue;
    this._updateStyles();
  }

};
Signals.addSignalMethods(Transparency.prototype);
