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
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Animator = imports.ui.animation;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { AppsScaffold, lg } = Me.imports.dock.utils;

const UIApp = GObject.registerClass(
  {
    Properties: {
      disabled: GObject.ParamSpec.boolean(
        'disabled',
        'disabled',
        'disabled',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        false,
        true,
        false
      )
    },
    Signals: {
      clicked: { param_types: [Object.prototype] },
      refresh: { param_types: [Object.prototype] }
    }
  },
  class UIApp extends GObject.Object {
    _init(params) {
      super._init();

      this._id = params.id;
      this._name = params.name;
      this._file = params.icon;
      this._disabledModeFile = params.disabled_icon;
      this._animatable = params.animatable;
      this._can_disable = params.can_disable;
      this._sprite = params.sprite;
      this._simulation = params.simulation;
      this.disabled = params.disabled ?? this.disabled;
      this._currentFile =
        this._can_disable && params.disabled
          ? params.disabled_icon
          : params.icon;
      this._params = params;

      lg('[UIApp::_init] disabled:', this.disabled);

      this.connect('notify::disabled', () => {
        this.emit('refresh', { disabled: this.disabled });
      });

      const file = Gio.File.new_for_path(params.disabled_icon);
      if (!file.query_exists(null)) {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(this._file);
        const extension = this._file.slice(this._file.lastIndexOf('.') + 1);
        pixbuf.saturate_and_pixelate(pixbuf, 0.0, false);
        pixbuf.savev(params.disabled_icon, extension, [], []);
      }
    }

    clone(props) {
      lg(
        '[UIApp::clone] props:',
        Object.entries(props),
        'params:',
        this._params
      );
      const newApp = new UIApp({ ...this._params, ...props });
      return newApp;
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

    can_disable() {
      return this._can_disable;
    }

    get_simulation() {
      return this._simulation;
    }

    hide_on_trigger() {
      return this._simulation.hideOnTrigger;
    }

    get_icon(size) {
      lg('[UIApp::get_icon] size:', size, 'file:', this._currentFile);
      if (!this._icon_cache) {
        if (!this._animatable) {
          this._icon_cache = new St.Icon({
            gicon: Gio.icon_new_for_string(this._currentFile)
          });
          this._icon_cache.set_size(size, size);
        } else if (this.disabled && this._animatable) {
          const sprite = this._sprite;
          const file = Gio.File.new_for_path(this._currentFile);
          lg('[UIApp::get_icon] file:', this._currentFile);
          const resourceScale = global.stage.get_resource_scale();
          let textureCache = St.TextureCache.get_default();
          let scaleFactor = St.ThemeContext.get_for_stage(
            global.stage
          ).scale_factor;
          this._icon_cache = textureCache.load_sliced_image(
            file,
            sprite.size,
            sprite.size,
            scaleFactor,
            resourceScale,
            () => this._icon_cache.get_child_at_index(0).show()
          );
          this._icon_cache.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
          });
          this._icon_cache.set_size(sprite.size, sprite.size);
        } else {
          const sprite = this._sprite;
          this._icon_cache = this.icon = new Animator.Animation(
            Gio.File.new_for_path(this._currentFile),
            sprite.size,
            sprite.size,
            sprite.rate
          );
          this._icon_cache.play();
        }
        this._icon_cache.connect('destroy', () => (this._icon_cache = null));
      }

      return this._icon_cache;
    }

    _rebuildIconCache() {
      lg('[UIApp::_rebuildIconCache]');
      this._icon_cache?.destroy();
      this._icon_cache = null;
      this._currentFile = this.disabled ? this._disabledModeFile : this._file;
      this.emit('refresh', { disabled: this.disabled });
    }

    click(button) {
     const disabled = this._can_disable && this.disabled;
     !disabled && this.emit('clicked', this.get_simulation());
    }

    destroy() {
      this._icon_cache?.destroy();
      this._icon_cache = null;
    }
  }
);

let _apps = null;

function getApps(props = {}) {
  if (_apps) {
    return _apps;
  }

  const apps = Object.values(AppsScaffold);
  _apps = apps.map((params) => new UIApp({ ...params, ...props }));

  return _apps;
}
