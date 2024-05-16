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

const Clutter = imports.gi.Clutter;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Docking = Me.imports.dock.docking;

const FRAME_SIZE = 36;
const FRAME_RATE = 15;

var SignalsHandlerFlags = {
  NONE: 0,
  CONNECT_AFTER: 1
};

var AppsID = {
  COPY: 'copy',
  SECTION: 'section',
  OCR: 'ocr',
  SNIP: 'snip',
  ROTATE_CLOCKWISE: 'rotate-clockwise',
  ROTATE_COUNTER_CLOCKWISE: 'rotate-counter-clockwise'
};

var { SCHEMA_NAME, lg } = Me.imports.utils;
/**
 * Simplify global signals and function injections handling
 * abstract class
 */
const BasicHandler = class DashToDock_BasicHandler {
  constructor(parentObject) {
    this._storage = new Object();

    if (parentObject) {
      if (!(parentObject.connect instanceof Function))
        throw new TypeError('Not a valid parent object');

      if (
        !(parentObject instanceof GObject.Object) ||
        GObject.signal_lookup('destroy', parentObject.constructor.$gtype)
      ) {
        this._parentObject = parentObject;
        this._destroyId = parentObject.connect('destroy', () => this.destroy());
      }
    }
  }

  add(...args) {
    // Convert arguments object to array, concatenate with generic
    // Call addWithLabel with ags as if they were passed arguments
    this.addWithLabel('generic', ...args);
  }

  destroy() {
    this._parentObject?.disconnect(this._destroyId);
    this._parentObject = null;

    for (let label in this._storage) this.removeWithLabel(label);
  }

  block() {
    Object.keys(this._storage).forEach((label) => this.blockWithLabel(label));
  }

  unblock() {
    Object.keys(this._storage).forEach((label) => this.unblockWithLabel(label));
  }

  addWithLabel(label, ...args) {
    let argsArray = [...args];
    if (argsArray.every((arg) => !Array.isArray(arg))) argsArray = [argsArray];

    if (this._storage[label] == undefined) this._storage[label] = new Array();

    // Skip first element of the arguments
    for (const argArray of argsArray) {
      if (argArray.length < 3)
        throw new Error('Unexpected number of arguments');
      let item = this._storage[label];
      try {
        item.push(this._create(...argArray));
      } catch (e) {
        logError(e);
      }
    }
  }

  removeWithLabel(label) {
    this._storage[label]?.reverse().forEach((item) => this._remove(item));
    delete this._storage[label];
  }

  blockWithLabel(label) {
    (this._storage[label] || []).forEach((item) => this._block(item));
  }

  unblockWithLabel(label) {
    (this._storage[label] || []).forEach((item) => this._unblock(item));
  }

  // Virtual methods to be implemented by subclass

  /**
   * Create single element to be stored in the storage structure
   */
  _create(_object, _element, _callback) {
    throw new GObject.NotImplementedError(
      `_create in ${this.constructor.name}`
    );
  }

  /**
   * Correctly delete single element
   */
  _remove(_item) {
    throw new GObject.NotImplementedError(
      `_remove in ${this.constructor.name}`
    );
  }

  /**
   * Block single element
   */
  _block(_item) {
    throw new GObject.NotImplementedError(`_block in ${this.constructor.name}`);
  }

  /**
   * Unblock single element
   */
  _unblock(_item) {
    throw new GObject.NotImplementedError(
      `_unblock in ${this.constructor.name}`
    );
  }
};

/**
 * Manage global signals
 */
var GlobalSignalsHandler = class DashToDock_GlobalSignalHandler extends BasicHandler {
  _create(object, event, callback, flags = SignalsHandlerFlags.NONE) {
    if (!object) throw new Error('Impossible to connect to an invalid object');

    let after = flags == SignalsHandlerFlags.CONNECT_AFTER;
    let connector = after ? object.connect_after : object.connect;

    if (!connector) {
      throw new Error(
        `Requested to connect to signal '${event}', ` +
          `but no implementation for 'connect${after ? '_after' : ''}' ` +
          `found in ${object.constructor.name}`
      );
    }

    let id = connector.call(object, event, callback);

    return [object, id];
  }

  _remove(item) {
    const [object, id] = item;
    object.disconnect(id);
  }

  _block(item) {
    const [object, id] = item;

    if (object instanceof GObject.Object)
      GObject.Object.prototype.block_signal_handler.call(object, id);
  }

  _unblock(item) {
    const [object, id] = item;

    if (object instanceof GObject.Object)
      GObject.Object.prototype.unblock_signal_handler.call(object, id);
  }
};

/**
 * Return the actual position reverseing left and right in rtl
 */
function getPosition() {
  return St.Side.RIGHT;
}

function getAlignment() {
  return Clutter.ActorAlign.CENTER;
}

var AppsScaffold = {
  [AppsID.COPY]: {
    id: AppsID.COPY,
    name: 'Copy Tool (Ctrl+C)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-copy-symbolic.png`,
    animatable: false,
    simulation: {
      event: {
        keyval: Clutter.KEY_C,
        modifier_state: Clutter.ModifierType.CONTROL_MASK,
        is_simulation: true
      },
      hideOnTrigger: true
    }
  },
  [AppsID.SECTION]: {
    id: AppsID.SECTION,
    name: 'Section Tool (Ctrl+Shift+C)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-section-symbolic.png`,
    animatable: false,
    simulation: {
      event: {
        keyval: Clutter.KEY_C,
        modifier_state:
          Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK,
        is_simulation: true
      },
      hideOnTrigger: false
    }
  },
  [AppsID.OCR]: {
    id: AppsID.OCR,
    name: 'Ocr Tool (O)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-ocr-sprite.png`,
    animatable: true,
    sprite: {
      size: FRAME_SIZE,
      rate: FRAME_RATE
    },
    simulation: {
      event: {
        keyval: Clutter.KEY_O,
        modifier_state: 0,
        is_simulation: true
      },
      hideOnTrigger: true
    }
  },
  [AppsID.SNIP]: {
    id: AppsID.SNIP,
    name: 'Snip Tool (X)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-snip-symbolic.png`,
    animatable: false,
    simulation: {
      event: {
        keyval: Clutter.KEY_X,
        modifier_state: 0,
        is_simulation: true
      },
      hideOnTrigger: true
    }
  },
  [AppsID.ROTATE_CLOCKWISE]: {
    id: AppsID.ROTATE_CLOCKWISE,
    name: 'Rotate Picture Clockwise (Ctrl+R)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-cycle-symbolic.png`,
    animatable: false,
    simulation: {
      event: {
        keyval: Clutter.KEY_R,
        modifier_state: Clutter.ModifierType.CONTROL_MASK,
        is_simulation: true
      },
      hideOnTrigger: false
    }
  },
  [AppsID.ROTATE_COUNTER_CLOCKWISE]: {
    id: AppsID.ROTATE_COUNTER_CLOCKWISE,
    name: 'Rotate Picture Counter Clockwise (Ctrl+L)',
    icon: `${Me.path}/assets/icons/pixzzle-ui-cycle-counter-symbolic.png`,
    animatable: false,
    simulation: {
      event: {
        keyval: Clutter.KEY_L,
        modifier_state: Clutter.ModifierType.CONTROL_MASK,
        is_simulation: true
      },
      hideOnTrigger: false
    }
  }
};
