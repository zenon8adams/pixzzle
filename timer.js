/* timer.js
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

const { GLib } = imports.gi;

var Timer = class Timer {
  constructor(hook) {
    this._hook = hook;
    hook.connect(
      'destroy',
      function () {
        if (this._timeoutId) {
          GLib.source_remove(this._timeoutId);
          this._timeoutId = null;
        }
      }.bind(this)
    );
  }

  add(timeout, callback, handle) {
    this._timeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      timeout,
      function () {
        callback.bind(this._hook)();
        this._timeoutId = null;
        return GLib.SOURCE_REMOVE;
      }.bind(this)
    );
    GLib.Source.set_name_by_id(this._timeoutId, `[pixzzle] ${handle}`);

    return this._timeoutId;
  }
}
