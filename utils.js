/* utils.js
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

const {Gio, GLib} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var SCHEMA_NAME = 'org.gnome.shell.extensions.pixzzle';

const debug = false;
function lg() {
  if (debug) {
    log('[' + SCHEMA_NAME + '] ' + Array.from(arguments).join(', '));
  }
}

function format() {
  const vicinity = arguments[0];
  const actualArgs = Array.from(arguments).slice(1);
  return ('[' + SCHEMA_NAME + '] ' +
          '[' + vicinity + '] ' + actualArgs.join(' '));
}

function inflateSettings() {
  const settings = ExtensionUtils.getSettings(SCHEMA_NAME);
  return settings;
}

const _getShotStore = function() {
  const path =
      Gio.File.new_for_path(GLib.build_filenamev(Array.from(arguments)));
  try {
    path.make_directory_with_parents(null);
  } catch (e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
      return null;
    }
  }

  return path;
};

var SHOT_STORE =
    _getShotStore(GLib.get_user_cache_dir(), 'extension', SCHEMA_NAME);
