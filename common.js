/* common.js
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

const { Gio, GLib, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { getShotsLocation } = Me.imports.utils;

/**
 * Stores a PNG-encoded screenshot into the clipboard and a file, and shows a
 * notification.
 *
 * @param {GLib.Bytes} bytes - The PNG-encoded screenshot.
 * @param {GdkPixbuf.Pixbuf} pixbuf - The Pixbuf with the screenshot.
 */
function storeScreenshot(bytes, pixbuf) {
  // Store to the clipboard first in case storing to file fails.
  const clipboard = St.Clipboard.get_default();
  clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

  const rand = GLib.uuid_string_random();
  const time = GLib.DateTime.new_now_local();
  const fmt = rand + '-%s';

  const lockdownSettings = new Gio.Settings({
    schema_id: 'org.gnome.desktop.lockdown'
  });
  const disableSaveToDisk = lockdownSettings.get_boolean(
    'disable-save-to-disk'
  );

  if (!disableSaveToDisk) {
    const dir = getShotsLocation();
    const timestamp = time.format('%Y-%m-%d-%H-%M-%S');
    const name = fmt.format(timestamp);

    const file = Gio.File.new_for_path(
      GLib.build_filenamev([dir.get_path(), `${name}.png`])
    );

    const stream = file.create(Gio.FileCreateFlags.NONE, null);
    stream.write_bytes(bytes, null);

    return file.get_path();
  }

  return null;
}
