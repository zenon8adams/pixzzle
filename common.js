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

const { Gio, GLib, St, Clutter } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { getShotsLocation, Constants } = Me.imports.utils;

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

function ensureActorVisibleInScrollView(scrollView, actor) {
  const { adjustment: vAdjustment } = scrollView.vscroll;
  const { adjustment: hAdjustment } = scrollView.hscroll;
  const { value: vValue0, pageSize: vPageSize, upper: vUpper } = vAdjustment;
  const { value: hValue0, pageSize: hPageSize, upper: hUpper } = hAdjustment;
  let [hValue, vValue] = [hValue0, vValue0];
  let vOffset = 0;
  let hOffset = 0;
  let fade = scrollView.get_effect('fade');
  if (fade) {
    vOffset = fade.fade_margins.top;
    hOffset = fade.fade_margins.left;
  }

  let box = actor.get_allocation_box();
  let y1 = box.y1,
    y2 = box.y2,
    x1 = box.x1,
    x2 = box.x2;

  let parent = actor.get_parent();
  while (parent != scrollView) {
    if (!parent) throw new Error('Actor not in scroll view');

    let box = parent.get_allocation_box();
    y1 += box.y1;
    y2 += box.y1;
    x1 += box.x1;
    x2 += box.x1;
    parent = parent.get_parent();
  }

  if (y1 < vValue + vOffset) vValue = Math.max(0, y1 - vOffset);
  else if (vValue < vUpper - vPageSize && y2 > vValue + vPageSize - vOffset)
    vValue = Math.min(vUpper - vPageSize, y2 + vOffset - vPageSize);

  if (x1 < hValue + hOffset) hValue = Math.max(0, x1 - hOffset);
  else if (hValue < hUpper - hPageSize && x2 > hValue + hPageSize - hOffset)
    hValue = Math.min(hUpper - hPageSize, x2 + hOffset - hPageSize);

  if (vValue !== vValue0) {
    vAdjustment.ease(vValue, {
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      duration: Constants.SCROLL_TIME
    });
  }

  if (hValue !== hValue0) {
    hAdjustment.ease(hValue, {
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      duration: Constants.SCROLL_TIME
    });
  }

  return [hValue - hValue0, vValue - vValue0];
}
