/* apps.js
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

const GObject = imports.gi.GObject;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Animator = imports.ui.animation;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { AppsScaffold } = Me.imports.dock.utils;

const UIApp = GObject.registerClass(
  {
    Signals: {
      clicked: { param_types: [Object.prototype] }
    }
  },
  class UIApp extends GObject.Object {
    _init(params) {
      super._init();

      this._id = params.id;
      this._name = params.name;
      this._file = params.icon;
      this._animatable = params.animatable;
      this._sprite = params.sprite;
      this._simulation = params.simulation;
    }

    get_id() {
      return this._id;
    }

    get_name() {
      return this._name;
    }

    animatable() {
      return this._animatable;
    }

    get_simulation() {
      return this._simulation;
    }

    hide_on_trigger() {
      return this._simulation.hideOnTrigger;
    }

    get_icon(size) {
      if (!this._icon_cache) {
        if (!this._animatable) {
          this._icon_cache = new St.Icon({
            gicon: Gio.icon_new_for_string(this._file)
          });
          this._icon_cache.set_size(size, size);
        } else {
          const sprite = this._sprite;
          this._icon_cache = this.icon = new Animator.Animation(
            Gio.File.new_for_path(this._file),
            sprite.size,
            sprite.size,
            sprite.rate
          );
        }
        this._icon_cache.connect('destroy', () => (this._icon_cache = null));
      }

      return this._icon_cache;
    }

    click(button) {
      this.emit('clicked', this.get_simulation());
    }
  }
);

function getApps() {
  const apps = Object.values(AppsScaffold);
  return apps.map((params) => new UIApp(params));
}
