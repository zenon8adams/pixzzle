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

const { Gio, GLib, Clutter } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var Constants = {
  FULLY_OPAQUE: 255,
  SCROLL_TIME: 100
};

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
  return (
    '[' + SCHEMA_NAME + '] ' + '[' + vicinity + '] ' + actualArgs.join(' ')
  );
}

function inflateSettings() {
  const settings = ExtensionUtils.getSettings(SCHEMA_NAME);
  return settings;
}

const _getShotStore = function () {
  const path = Gio.File.new_for_path(
    GLib.build_filenamev(Array.from(arguments))
  );
  try {
    path.make_directory_with_parents(null);
  } catch (e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
      return null;
    }
  }

  return path;
};

function getShotsLocation() {
  return _getShotStore(GLib.get_user_cache_dir(), 'extension', SCHEMA_NAME);
}

function getThumbnailsLocation() {
  return _getShotStore(getShotsLocation().get_path(), '.thumbnail');
}

function getDate(fullname) {
  const name = GLib.path_get_basename(fullname);
  const uuid = GLib.uuid_string_random().length + 1;
  const effective = name.slice(uuid, name.indexOf('.'));
  const parts = effective.match(/(\d+-\d+-\d+)-(\d+-\d+-\d+)/);
  const [date, time] = [parts[1], parts[2].replaceAll('-', ':')];
  return Date.parse(date + ' ' + time);
}

function filesDateSorter(one, other) {
  const oneDate = getDate(one);
  const otherDate = getDate(other);
  return oneDate > otherDate ? -1 : oneDate < otherDate ? 1 : 0;
}

function fmt(shot) {
  const format = new Date(shot).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return format;
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
