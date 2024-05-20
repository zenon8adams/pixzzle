/* tooltip.js
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

const { GObject, GLib, Clutter, St } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { lg } = Me.imports.utils;

var UITooltip = GObject.registerClass(
  class UITooltip extends St.Label {
    _init(widget, params) {
      super._init(params);

      this._widget = widget;
      this._timeoutId = null;

      this._widget.connect('notify::hover', () => {
        if (this._widget.hover) this.open();
        else this.close();
      });
    }

    open() {
      if (this._timeoutId) return;

      this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this.opacity = 0;
        this.show();

        const extents = this._widget.get_transformed_extents();

        const xOffset = Math.floor((extents.get_width() - this.width) / 2);
        const x = Math.clamp(
          extents.get_x() + xOffset,
          0,
          global.stage.width - this.width
        );

        const node = this.get_theme_node();
        const yOffset = node.get_length('-y-offset');

        const y = extents.get_y() - this.height - yOffset;

        this.set_position(x, y);
        this.ease({
          opacity: 255,
          duration: 150,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        this._timeoutId = null;
        return GLib.SOURCE_REMOVE;
      });
      GLib.Source.set_name_by_id(this._timeoutId, '[pixzzle] tooltip.open');
    }

    close() {
      if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = null;
        return;
      }

      if (!this.visible) return;

      this.remove_all_transitions();
      this.ease({
        opacity: 0,
        duration: 100,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.hide()
      });
    }
  }
);
