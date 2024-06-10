/* watcher.js
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

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { lg } = Me.imports.utils;

// We stop polling if the user is idle for more than this amount of time
const IDLE_TIME = 1000;

// This file implements a reasonably efficient system for tracking user
// defined state
// We simply query `stateCheckout` in a loop,
// but we turn off the polling when the user is idle.

let _actionWatcher = null;

/**
 * @returns {ActionWatcher}
 */
function getActionWatcher() {
  if (_actionWatcher == null) _actionWatcher = new ActionWatcher();

  return _actionWatcher;
}

class ActionWatch {
  constructor(watcher, interval, callbacks) {
    this.watcher = watcher;
    this.interval = interval;
    this.callback = callbacks.reaction;
    this.next = callbacks.action;
    this.compare = callbacks.compare;
    this.data = null;
  }

  hasNext() {
    const current = this.next();
    if (this.compare(current, this.data)) {
      return false;
    }

    this.data = current;
    return true;
  }

  // remove this watch. This function may safely be called
  // while the callback is executing.
  remove() {
    this.watcher._removeWatch(this);
  }
}

class ActionWatcher {
  constructor() {
    const has_idle_monitor = global.backend.get_core_idle_monitor;
    this._has_idle_monitor = has_idle_monitor;
    if (this._has_idle_monitor) {
      this._idleMonitor = global.backend.get_core_idle_monitor();
      this._idle_watch = this._idleMonitor.add_idle_watch(
        IDLE_TIME,
        this._onIdleMonitorBecameIdle.bind(this)
      );
      this._idle = this._idleMonitor.get_idletime() > IDLE_TIME;
    } else {
      this._poll();
    }
    this._watches = [];
  }

  _poll() {
    this._watchId = GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, IDLE_TIME, () => {
      this._onIdleMonitorBecameActive();
      GLib.source_remove(this._watchId);
      this._watchId = 0;
      this._poll();
      return GLib.SOURCE_REMOVE;
    });
  }

  addWatch(interval, callbacks) {
    this._updateActions();

    let watch = new ActionWatch(this, interval, callbacks);
    this._watches.push(watch);
    this._updateTimeout();
    return this;
  }

  _removeWatch(watch) {
    for (let i = 0; i < this._watches.length; i++) {
      if (this._watches[i] === watch) {
        this._watches.splice(i, 1);
        this._updateTimeout();
        return;
      }
    }
  }

  destroy() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = 0;
    }
    if(this._watchId) {
        GLib.source_remove(this._watchId);
        this._watchId = 0;
    }
    if (this._has_idle_monitor) {
      this._idleMonitor.remove_watch(this._idle_watch);
      this._idleMonitor.remove_watch(this._user_active_watch);
      this._watches.forEach((watch) => watch.remove());
    }
    this._watches = [];
  }

  _onIdleMonitorBecameActive() {
    lg('[ActionWatcher::_onIdleMonitorBecameActive]');
    this._idle = false;
    this._updateActions();
    this._updateTimeout();
  }

  _onIdleMonitorBecameIdle() {
    this._idle = true;
    this._user_active_watch = this._idleMonitor.add_user_active_watch(
      this._onIdleMonitorBecameActive.bind(this)
    );
    this._updateTimeout();
  }

  _updateTimeout() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = 0;
    }

    if (this._idle || this._watches.length === 0) return;

    let minInterval = this._watches[0].interval;
    for (let i = 1; i < this._watches.length; i++)
      minInterval = Math.min(this._watches[i].interval, minInterval);

    this._timeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      minInterval,
      this._onTimeout.bind(this)
    );
    GLib.Source.set_name_by_id(this._timeoutId, '[pixzzle] this._onTimeout');
  }

  _onTimeout() {
    this._updateActions();
    return GLib.SOURCE_CONTINUE;
  }

  _updateActions() {
    for (let i = 0; i < this._watches.length; ) {
      if (!this._watches[i].hasNext()) {
        ++i;
        continue;
      }

      let watch = this._watches[i];
      watch.callback(watch.data);
      if (watch === this._watches[i])
        // guard against self-removal
        i++;
    }
  }
}
