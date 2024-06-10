/* screenshot.js
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

/* exported init */
// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const {
  Clutter,
  Cogl,
  Gio,
  GObject,
  GLib,
  Graphene,
  Meta,
  Shell,
  St,
  GdkPixbuf
} = imports.gi;

const GrabHelper = imports.ui.grabHelper;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Layout = imports.ui.layout;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext.domain(Me.metadata['gettext-domain']);
const _ = Gettext.gettext;

const {
  inflateSettings,
  SCHEMA_NAME,
  lg,
  getShotsLocation,
  getIconsLocation,
  format
} = Me.imports.utils;
const { storeScreenshot } = Me.imports.common;
const { UITooltip } = Me.imports.tooltip;

const IconLabelButton = GObject.registerClass(
  class IconLabelButton extends St.Button {
    _init(iconName, label, params) {
      super._init(params);

      this._container = new St.BoxLayout({
        vertical: true,
        style_class: 'icon-label-button-container'
      });
      this.set_child(this._container);

      this._container.add_child(
        new St.Icon({ gicon: Gio.icon_new_for_string(iconName) })
      );
      this._container.add_child(
        new St.Label({ text: label, x_align: Clutter.ActorAlign.CENTER })
      );
    }
  }
);

const UIAreaIndicator = GObject.registerClass(
  class UIAreaIndicator extends St.Widget {
    _init(params) {
      super._init(params);
      /*
       *   We make this structure
       *   +------------------+
       *   |        TR        |
       *   +------++----++----+
       *   |  LR  || SR || RR |
       *   +------++----++----+
       *   |        BR        |
       *   +------------------+
       *   TR -> Top rect
       *   LR -> Left rect
       *   RR -> Right rect
       *   BR -> Bottom rect
       *   SR -> Selection rect
       *
       *   Anytime we set the size
       *   of the selection rect,
       *   all the anchors(constraints)
       *   we have will stretch/strain
       *   to give space for the
       *   selection rectangle.
       */

      this._topRect = new St.Widget({
        style_class: 'pixzzle-ui-area-indicator-shade'
      });
      this._topRect.add_constraint(
        new Clutter.BindConstraint({
          source: this,
          coordinate: Clutter.BindCoordinate.WIDTH
        })
      );
      this._topRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.TOP
        })
      );
      this._topRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.LEFT,
          to_edge: Clutter.SnapEdge.LEFT
        })
      );
      this.add_child(this._topRect);

      this._bottomRect = new St.Widget({
        style_class: 'pixzzle-ui-area-indicator-shade'
      });
      this._bottomRect.add_constraint(
        new Clutter.BindConstraint({
          source: this,
          coordinate: Clutter.BindCoordinate.WIDTH
        })
      );
      this._bottomRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.BOTTOM
        })
      );
      this._bottomRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.LEFT,
          to_edge: Clutter.SnapEdge.LEFT
        })
      );
      this.add_child(this._bottomRect);

      this._leftRect = new St.Widget({
        style_class: 'pixzzle-ui-area-indicator-shade'
      });
      this._leftRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.LEFT,
          to_edge: Clutter.SnapEdge.LEFT
        })
      );
      this._leftRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._topRect,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.BOTTOM
        })
      );
      this._leftRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._bottomRect,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.TOP
        })
      );
      this.add_child(this._leftRect);

      this._rightRect = new St.Widget({
        style_class: 'pixzzle-ui-area-indicator-shade'
      });
      this._rightRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this,
          from_edge: Clutter.SnapEdge.RIGHT,
          to_edge: Clutter.SnapEdge.RIGHT
        })
      );
      this._rightRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._topRect,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.BOTTOM
        })
      );
      this._rightRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._bottomRect,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.TOP
        })
      );
      this.add_child(this._rightRect);

      this._selectionRect = new St.Widget({
        style_class: 'pixzzle-ui-area-indicator-selection'
      });
      this.add_child(this._selectionRect);

      this._topRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._selectionRect,
          from_edge: Clutter.SnapEdge.BOTTOM,
          to_edge: Clutter.SnapEdge.TOP
        })
      );

      this._bottomRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._selectionRect,
          from_edge: Clutter.SnapEdge.TOP,
          to_edge: Clutter.SnapEdge.BOTTOM
        })
      );

      this._leftRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._selectionRect,
          from_edge: Clutter.SnapEdge.RIGHT,
          to_edge: Clutter.SnapEdge.LEFT
        })
      );

      this._rightRect.add_constraint(
        new Clutter.SnapConstraint({
          source: this._selectionRect,
          from_edge: Clutter.SnapEdge.LEFT,
          to_edge: Clutter.SnapEdge.RIGHT
        })
      );
    }

    setSelectionRect(x, y, width, height) {
      this._selectionRect.set_position(x, y);
      this._selectionRect.set_size(width, height);
    }
  }
);

const UIAreaSelector = GObject.registerClass(
  { Signals: { 'drag-started': {}, 'drag-ended': {} } },
  class UIAreaSelector extends St.Widget {
    _init(params) {
      super._init(params);

      // During a drag, this can be Clutter.BUTTON_PRIMARY,
      // Clutter.BUTTON_SECONDARY or the string "touch" to identify the
      // source of the drag operation.
      this._dragButton = 0;
      this._dragSequence = null;

      this._areaIndicator = new UIAreaIndicator();
      this._areaIndicator.add_constraint(
        new Clutter.BindConstraint({
          source: this,
          coordinate: Clutter.BindCoordinate.ALL
        })
      );
      this.add_child(this._areaIndicator);

      this._topLeftHandle = new St.Widget({
        style_class: 'pixzzle-ui-area-selector-handle'
      });
      this.add_child(this._topLeftHandle);
      this._topRightHandle = new St.Widget({
        style_class: 'pixzzle-ui-area-selector-handle'
      });
      this.add_child(this._topRightHandle);
      this._bottomLeftHandle = new St.Widget({
        style_class: 'pixzzle-ui-area-selector-handle'
      });
      this.add_child(this._bottomLeftHandle);
      this._bottomRightHandle = new St.Widget({
        style_class: 'pixzzle-ui-area-selector-handle'
      });
      this.add_child(this._bottomRightHandle);

      // This will be updated before the first drawn frame.
      this._handleSize = 0;
      this._topLeftHandle.connect('style-changed', (widget) => {
        this._handleSize = widget.get_theme_node().get_width();
        this._updateSelectionRect();
      });

      this.connect('notify::mapped', () => {
        if (this.mapped) {
          const [x, y] = global.get_pointer();
          this._updateCursor(x, y);
        }
      });

      // Initialize area to out of bounds so reset() below resets it.
      // This is the selection rectangle
      /*
       * (_startX, _startY)
       *         +----------------+
       *         |                |
       *         |                |
       *         |                |
       *         |                |
       *         +----------------+
       *                   (_lastX, _lastY)
       */
      this._startX = -1;
      this._startY = 0;
      this._lastX = 0;
      this._lastY = 0;

      this.reset();
    }

    reset() {
      this.stopDrag();
      global.display.set_cursor(Meta.Cursor.DEFAULT);

      // Preserve area selection if possible. If the area goes out of
      // bounds, the monitors might have changed, so reset the area.
      const [x, y, w, h] = this.getGeometry();
      if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) {
        // Initialize area to out of bounds so if there's no monitor,
        // the area will be reset once a monitor does appear.
        this._startX = -1;
        this._startY = 0;
        this._lastX = 0;
        this._lastY = 0;

        // This can happen when running headless without any monitors.
        if (Main.layoutManager.primaryIndex !== -1) {
          const monitor =
            Main.layoutManager.monitors[Main.layoutManager.primaryIndex];

          /*
           * Set the initial dimension of the selection rect
           */
          this._startX = monitor.x + Math.floor((monitor.width * 3) / 8);
          this._startY = monitor.y + Math.floor((monitor.height * 3) / 8);
          this._lastX = monitor.x + Math.floor((monitor.width * 5) / 8) - 1;
          this._lastY = monitor.y + Math.floor((monitor.height * 5) / 8) - 1;
        }

        this._updateSelectionRect();
      }
    }

    expandHandles() {
      if (Main.layoutManager.primaryIndex !== -1) {
        const monitor =
          Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
        this._startX = monitor.x;
        this._startY = monitor.y;
        this._lastX = monitor.x + monitor.width - 1;
        this._lastY = monitor.y + monitor.height - 1;

        this._updateSelectionRect();
      }
    }

    /*
     * Returns the [x, y, w, h] of this geometry
     */
    getGeometry() {
      const leftX = Math.min(this._startX, this._lastX);
      const topY = Math.min(this._startY, this._lastY);
      const rightX = Math.max(this._startX, this._lastX);
      const bottomY = Math.max(this._startY, this._lastY);

      return [leftX, topY, rightX - leftX + 1, bottomY - topY + 1];
    }

    _updateSelectionRect() {
      const [x, y, w, h] = this.getGeometry();
      this._areaIndicator.setSelectionRect(x, y, w, h);

      /*
       * Update the selection rectangle handles with
       * the newly computed dimensions of the
       * selection rectangle using the center point
       * of the handle (i.e offset).
       */
      const offset = this._handleSize / 2;
      this._topLeftHandle.set_position(x - offset, y - offset);
      this._topRightHandle.set_position(x + w - 1 - offset, y - offset);
      this._bottomLeftHandle.set_position(x - offset, y + h - 1 - offset);
      this._bottomRightHandle.set_position(
        x + w - 1 - offset,
        y + h - 1 - offset
      );
    }

    _computeCursorType(cursorX, cursorY) {
      const [leftX, topY, width, height] = this.getGeometry();
      const [rightX, bottomY] = [leftX + width - 1, topY + height - 1];
      const [x, y] = [cursorX, cursorY];

      // Check if the cursor overlaps the handles first.
      const limit = (this._handleSize / 2) ** 2;
      if ((leftX - x) ** 2 + (topY - y) ** 2 <= limit)
        return Meta.Cursor.NW_RESIZE;
      else if ((rightX - x) ** 2 + (topY - y) ** 2 <= limit)
        return Meta.Cursor.NE_RESIZE;
      else if ((leftX - x) ** 2 + (bottomY - y) ** 2 <= limit)
        return Meta.Cursor.SW_RESIZE;
      else if ((rightX - x) ** 2 + (bottomY - y) ** 2 <= limit)
        return Meta.Cursor.SE_RESIZE;

      // Now check the rest of the rectangle.
      const threshold =
        5 * St.ThemeContext.get_for_stage(global.stage).scaleFactor;

      /*
       *  We compute the cursor type on this basis:
       *  For this expression,
       *  leftX - x >= 0 && leftX - x <= threshold
       *  Imagine the cursor coming into the left
       *  boundary of the selection rectangle and
       *  is has just gone past the left rectangle
       *  boundary by at most threshold, we would
       *  have fallen on the left rectangle
       *  boundary.
       *  There are three possible cases for the
       *  y-axis of the cursor:
       *  1. It is very close the the top-left
       *  corner of the rectangle(NW_RESIZE).
       *  2. It is very close to the bottom-left
       *  corner of the rectangle(SW_RESIZE).
       *  3. It is between the top-left and the
       *  bottom-left corners of the rectangle
       *  (i.e it is the left edge of the rect)
       *  (WEST_RESIZE).
       *
       *  The other cases can the thought of as
       *  rotating the rectangle and repeating
       *  this process for each sides.
       */
      if (leftX - x >= 0 && leftX - x <= threshold) {
        if (topY - y >= 0 && topY - y <= threshold)
          return Meta.Cursor.NW_RESIZE;
        else if (y - bottomY >= 0 && y - bottomY <= threshold)
          return Meta.Cursor.SW_RESIZE;
        else if (topY - y < 0 && y - bottomY < 0)
          return Meta.Cursor.WEST_RESIZE;
      } else if (x - rightX >= 0 && x - rightX <= threshold) {
        if (topY - y >= 0 && topY - y <= threshold)
          return Meta.Cursor.NE_RESIZE;
        else if (y - bottomY >= 0 && y - bottomY <= threshold)
          return Meta.Cursor.SE_RESIZE;
        else if (topY - y < 0 && y - bottomY < 0)
          return Meta.Cursor.EAST_RESIZE;
      } else if (leftX - x < 0 && x - rightX < 0) {
        if (topY - y >= 0 && topY - y <= threshold)
          return Meta.Cursor.NORTH_RESIZE;
        else if (y - bottomY >= 0 && y - bottomY <= threshold)
          return Meta.Cursor.SOUTH_RESIZE;
        else if (topY - y < 0 && y - bottomY < 0)
          return Meta.Cursor.MOVE_OR_RESIZE_WINDOW;
      }

      return Meta.Cursor.CROSSHAIR;
    }

    stopDrag() {
      if (!this._dragButton) return;

      if (this._dragGrab) {
        this._dragGrab.dismiss();
        this._dragGrab = null;
      }

      this._dragButton = 0;
      this._dragSequence = null;

      if (
        this._dragCursor === Meta.Cursor.CROSSHAIR &&
        this._lastX === this._startX &&
        this._lastY === this._startY
      ) {
        // The user clicked without dragging. Make up a larger selection
        // to reduce confusion.
        const offset =
          20 * St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        // Expand the rectangle by offset
        this._startX -= offset;
        this._startY -= offset;
        this._lastX += offset;
        this._lastY += offset;

        // Keep the coordinates inside the stage.
        if (this._startX < 0) {
          this._lastX -= this._startX;
          this._startX = 0;
        } else if (this._lastX >= this.width) {
          this._startX -= this._lastX - this.width + 1;
          this._lastX = this.width - 1;
        }

        if (this._startY < 0) {
          this._lastY -= this._startY;
          this._startY = 0;
        } else if (this._lastY >= this.height) {
          this._startY -= this._lastY - this.height + 1;
          this._lastY = this.height - 1;
        }

        this._updateSelectionRect();
      }

      this.emit('drag-ended');
    }

    _updateCursor(x, y) {
      const cursor = this._computeCursorType(x, y);
      global.display.set_cursor(cursor);
    }

    _onPress(event, button, sequence) {
      if (this._dragButton) return Clutter.EVENT_PROPAGATE;

      const [x, y] = [event.x, event.y];
      const cursor = this._computeCursorType(x, y);

      // Clicking outside of the selection, or using the right mouse
      // button, or with Ctrl results in dragging a new selection from
      // scratch.
      if (
        cursor === Meta.Cursor.CROSSHAIR ||
        button === Clutter.BUTTON_SECONDARY ||
        event.modifier_state & Clutter.ModifierType.CONTROL_MASK
      ) {
        this._dragButton = button;

        this._dragCursor = Meta.Cursor.CROSSHAIR;
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);

        [this._startX, this._startY] = [event.x, event.y];
        this._lastX = this._startX = Math.floor(this._startX);
        this._lastY = this._startY = Math.floor(this._startY);

        this._updateSelectionRect();
      } else {
        // This is a move or resize operation.
        this._dragButton = button;

        this._dragCursor = cursor;
        [this._dragStartX, this._dragStartY] = [event.x, event.y];

        const [leftX, topY, width, height] = this.getGeometry();
        const rightX = leftX + width - 1;
        const bottomY = topY + height - 1;

        // For moving, start X and Y are the top left corner, while
        // last X and Y are the bottom right corner.
        if (cursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
          this._startX = leftX;
          this._startY = topY;
          this._lastX = rightX;
          this._lastY = bottomY;
        }

        // Start X and Y are set to the stationary sides, while last X
        // and Y are set to the moving sides.
        /*
         *
         * If the north-east handle is dragged for example,
         * we have to update y-coordinate of the north-west(top-left)
         * handle, and the x-coordinate of the south-east(bottom-right)
         * handle.
         *
         *  We update to                 The dragged
         *  this y-coordinate               handle
         *      !                             !
         *      +-----------------------------+
         *      |                             |
         *      +----------------+            |
         *      |                |  The new   |
         *      | Rectangle      |  size of   |
         *      | size before    |  the       |
         *      | the north-east |  selection |
         *      | handle was     |  after     |
         *      | dragged.       |  dragging. |
         *      |                |            |
         *      +----------------+------------+
         *                                    ^
         *                               We update to
         *                               this x-coordinate
         *
         *    In this example case,
         *    we set this._startX to the x-coordinate
         *    of north-west handle (i.e the stationary side),
         *    we set this._startY to the y-coordinate
         *    of south-east handle (i.e the stationary side).
         *    We set the y-coordinate of top-left corner to
         *    lastY and the x-coordinate of the bottom-right
         *    corner leftX. It doesn't really matter if we
         *    picked this._startX and this._lastY since our
         *    this.getGeometry() function uses a min-max to
         *    determine the bounding box of the current
         *    selection.
         */
        if (
          cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.WEST_RESIZE ||
          cursor === Meta.Cursor.SW_RESIZE
        ) {
          this._startX = rightX;
          this._lastX = leftX;
        }
        if (
          cursor === Meta.Cursor.NE_RESIZE ||
          cursor === Meta.Cursor.EAST_RESIZE ||
          cursor === Meta.Cursor.SE_RESIZE
        ) {
          this._startX = leftX;
          this._lastX = rightX;
        }
        if (
          cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.NORTH_RESIZE ||
          cursor === Meta.Cursor.NE_RESIZE
        ) {
          this._startY = bottomY;
          this._lastY = topY;
        }
        if (
          cursor === Meta.Cursor.SW_RESIZE ||
          cursor === Meta.Cursor.SOUTH_RESIZE ||
          cursor === Meta.Cursor.SE_RESIZE
        ) {
          this._startY = topY;
          this._lastY = bottomY;
        }
      }

      if (this._dragButton) {
        this._dragGrab = global.stage.grab(this);
        this.emit('drag-started');

        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    }

    _onRelease(event, button, sequence) {
      if (
        this._dragButton !== button ||
        this._dragSequence?.get_slot() !== sequence?.get_slot()
      )
        return Clutter.EVENT_PROPAGATE;

      this.stopDrag();

      // We might have finished creating a new selection, so we need to
      // update the cursor.
      const [x, y] = [event.x, event.y];
      this._updateCursor(x, y);

      return Clutter.EVENT_STOP;
    }

    _onMotion(event, sequence) {
      if (!this._dragButton) {
        const [x, y] = [event.x, event.y];
        this._updateCursor(x, y);
        return Clutter.EVENT_PROPAGATE;
      }

      if (sequence?.get_slot() !== this._dragSequence?.get_slot())
        return Clutter.EVENT_PROPAGATE;

      if (this._dragCursor === Meta.Cursor.CROSSHAIR) {
        [this._lastX, this._lastY] = [event.x, event.y];
        this._lastX = Math.floor(this._lastX);
        this._lastY = Math.floor(this._lastY);
      } else {
        const [x, y] = [event.x, event.y];
        let dx = Math.round(x - this._dragStartX);
        let dy = Math.round(y - this._dragStartY);

        if (this._dragCursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
          const [, , selectionWidth, selectionHeight] = this.getGeometry();

          let newStartX = this._startX + dx;
          let newStartY = this._startY + dy;
          let newLastX = this._lastX + dx;
          let newLastY = this._lastY + dy;

          /*
           * To understand the purpose of the overshoot,
           * Let us imagine a cursor that appears
           * at a position past the edge of the screen:
           *
           * The start
           * of rectangle
           * returned due   The actual
           * to overshoot   starting position
           * in the x-axis  of the monitor
           *   !              !
           *   +--------------+-----------------------+
           *   |              |                       |
           *   |              |                       |
           *   |              |                       |
           *   |              |                       |
           *   +--------------+-----------------------+
           *   The dx computation will be a negative
           *   value and is excess by the overshootX
           *   (i.e -newStartX) we have to remove
           *   this value from dx by adding it to
           *   the negative dx in order to bring it
           *   to zero.
           */

          let overshootX = 0;
          let overshootY = 0;

          // Keep the size intact if we bumped into the stage edge.
          if (newStartX < 0) {
            overshootX = 0 - newStartX;
            newStartX = 0;
            newLastX = newStartX + (selectionWidth - 1);
          } else if (newLastX > this.width - 1) {
            overshootX = this.width - 1 - newLastX;
            newLastX = this.width - 1;
            newStartX = newLastX - (selectionWidth - 1);
          }

          if (newStartY < 0) {
            overshootY = 0 - newStartY;
            newStartY = 0;
            newLastY = newStartY + (selectionHeight - 1);
          } else if (newLastY > this.height - 1) {
            overshootY = this.height - 1 - newLastY;
            newLastY = this.height - 1;
            newStartY = newLastY - (selectionHeight - 1);
          }

          // Add the overshoot to the delta to create a
          // "rubberbanding" behavior of the pointer when dragging.
          dx += overshootX;
          dy += overshootY;

          this._startX = newStartX;
          this._startY = newStartY;
          this._lastX = newLastX;
          this._lastY = newLastY;
        } else {
          if (
            this._dragCursor === Meta.Cursor.WEST_RESIZE ||
            this._dragCursor === Meta.Cursor.EAST_RESIZE
          )
            dy = 0;
          if (
            this._dragCursor === Meta.Cursor.NORTH_RESIZE ||
            this._dragCursor === Meta.Cursor.SOUTH_RESIZE
          )
            dx = 0;

          // Make sure last X and Y are clamped between 0 and size -
          // 1, while always preserving the cursor dragging position
          // relative to the selection rectangle.
          //
          // What we are doing here is also removing the
          // overshoot that is in dx and dy due to dragging
          // past the edge of the monitor. See figure above.
          this._lastX += dx;
          if (this._lastX >= this.width) {
            dx -= this._lastX - this.width + 1;
            this._lastX = this.width - 1;
          } else if (this._lastX < 0) {
            dx -= this._lastX;
            this._lastX = 0;
          }

          this._lastY += dy;
          if (this._lastY >= this.height) {
            dy -= this._lastY - this.height + 1;
            this._lastY = this.height - 1;
          } else if (this._lastY < 0) {
            dy -= this._lastY;
            this._lastY = 0;
          }

          // If we drag the handle past a selection side, update which
          // handles are which.
          /*
           *  Example:
           *
           * The this._lastX(which had `leftX` saved in it) is
           * x-coordinate of point A, and this._lastY(which
           * had `topY` saved in it) is y-coordinate of point `A`.
           *
           * If we have gone from this:
           *
           *  A-------------B
           *  |             |
           *  |             |
           *  |             |
           *  |             |
           *  C-------------D
           *                .
           *  to this:      .
           *                .
           *                B-------------A
           *                |             |
           *                |             |
           *                |             |
           *                |             |
           *                D-------------C
           *
           * After the lateral inversion, the this._lastX(which
           * is now positioned at the `new A`) would be greater
           * than the this._startX(which had `rightX` saved in it).
           * We have to change the cursor pointer from `NW_RESIZE`
           * to `NE_RESIZE`.
           */
          if (this._lastX > this._startX) {
            if (this._dragCursor === Meta.Cursor.NW_RESIZE)
              this._dragCursor = Meta.Cursor.NE_RESIZE;
            else if (this._dragCursor === Meta.Cursor.SW_RESIZE)
              this._dragCursor = Meta.Cursor.SE_RESIZE;
            else if (this._dragCursor === Meta.Cursor.WEST_RESIZE)
              this._dragCursor = Meta.Cursor.EAST_RESIZE;
          } else {
            // eslint-disable-next-line no-lonely-if
            if (this._dragCursor === Meta.Cursor.NE_RESIZE)
              this._dragCursor = Meta.Cursor.NW_RESIZE;
            else if (this._dragCursor === Meta.Cursor.SE_RESIZE)
              this._dragCursor = Meta.Cursor.SW_RESIZE;
            else if (this._dragCursor === Meta.Cursor.EAST_RESIZE)
              this._dragCursor = Meta.Cursor.WEST_RESIZE;
          }

          if (this._lastY > this._startY) {
            if (this._dragCursor === Meta.Cursor.NW_RESIZE)
              this._dragCursor = Meta.Cursor.SW_RESIZE;
            else if (this._dragCursor === Meta.Cursor.NE_RESIZE)
              this._dragCursor = Meta.Cursor.SE_RESIZE;
            else if (this._dragCursor === Meta.Cursor.NORTH_RESIZE)
              this._dragCursor = Meta.Cursor.SOUTH_RESIZE;
          } else {
            // eslint-disable-next-line no-lonely-if
            if (this._dragCursor === Meta.Cursor.SW_RESIZE)
              this._dragCursor = Meta.Cursor.NW_RESIZE;
            else if (this._dragCursor === Meta.Cursor.SE_RESIZE)
              this._dragCursor = Meta.Cursor.NE_RESIZE;
            else if (this._dragCursor === Meta.Cursor.SOUTH_RESIZE)
              this._dragCursor = Meta.Cursor.NORTH_RESIZE;
          }

          global.display.set_cursor(this._dragCursor);
        }

        this._dragStartX += dx;
        this._dragStartY += dy;
      }

      this._updateSelectionRect();

      return Clutter.EVENT_STOP;
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onPress(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onRelease(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

    vfunc_touch_event(event) {
      const eventType = event.type;
      if (eventType === Clutter.EventType.TOUCH_BEGIN)
        return this._onPress(event, 'touch', event.get_event_sequence());
      else if (eventType === Clutter.EventType.TOUCH_END)
        return this._onRelease(event, 'touch', event.get_event_sequence());
      else if (eventType === Clutter.EventType.TOUCH_UPDATE)
        return this._onMotion(event, event.get_event_sequence());

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
      // If we're dragging and go over the panel we still get a leave
      // event for some reason, even though we have a grab. We don't want
      // to switch the cursor when we're dragging.
      if (!this._dragButton) global.display.set_cursor(Meta.Cursor.DEFAULT);

      return super.vfunc_leave_event(event);
    }
  }
);

var UIShutter = GObject.registerClass(
  {
    Signals: {
      'begin-close': {},
      'new-shot': { param_types: [Object.prototype] }
    }
  },
  class UIShutter extends St.Widget {
    _init() {
      super._init({
        name: 'screenshot',
        constraints: new Clutter.BindConstraint({
          source: global.stage,
          coordinate: Clutter.BindCoordinate.ALL
        }),
        layout_manager: new Clutter.BinLayout(),
        opacity: 0,
        visible: false,
        reactive: true
      });

      // The full-screen screenshot has a separate container so that we can
      // show it without the screenshot UI fade-in for a nicer animation.
      this._stageScreenshotContainer = new St.Widget({ visible: false });
      this._stageScreenshotContainer.add_constraint(
        new Clutter.BindConstraint({
          source: global.stage,
          coordinate: Clutter.BindCoordinate.ALL
        })
      );

      this._screenshotUIGroup = new St.Widget({
        name: 'screenshotUIGroup',
        layout_manager: new Clutter.BinLayout()
      });
      Main.layoutManager.addTopChrome(this._screenshotUIGroup);

      this._screenshotUIGroup.add_child(this._stageScreenshotContainer);

      this._screenshotUIGroup.add_child(this);

      this._stageScreenshot = new St.Widget({
        style_class: 'pixzzle-ui-screen-screenshot'
      });
      this._stageScreenshot.add_constraint(
        new Clutter.BindConstraint({
          source: global.stage,
          coordinate: Clutter.BindCoordinate.ALL
        })
      );
      this._stageScreenshotContainer.add_child(this._stageScreenshot);

      this._openingCoroutineInProgress = false;
      this._grabHelper = new GrabHelper.GrabHelper(this, {
        actionMode: Shell.ActionMode.POPUP
      });

      this._areaSelector = new UIAreaSelector({
        style_class: 'pixzzle-ui-area-selector',
        x_expand: true,
        y_expand: true,
        reactive: true
      });
      this.add_child(this._areaSelector);

      this._primaryMonitorBin = new St.Widget({
        layout_manager: new Clutter.BinLayout()
      });
      this._primaryMonitorBin.add_constraint(
        new Layout.MonitorConstraint({ primary: true })
      );
      this.add_child(this._primaryMonitorBin);

      this._panel = new St.BoxLayout({
        style_class: 'pixzzle-ui-panel',
        y_align: Clutter.ActorAlign.END,
        y_expand: true,
        vertical: true,
        offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY
      });
      this._primaryMonitorBin.add_child(this._panel);

      this._closeButton = new St.Button({
        style_class: 'pixzzle-ui-close-button',
        child: new St.Icon({ icon_name: 'preview-close-symbolic' })
      });

      this._closeButton.add_constraint(
        new Clutter.BindConstraint({
          source: this._panel,
          coordinate: Clutter.BindCoordinate.POSITION
        })
      );
      this._closeButton.add_constraint(
        new Clutter.AlignConstraint({
          source: this._panel,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          pivot_point: new Graphene.Point({ x: -1, y: 0.5 }),
          factor: 0
        })
      );
      this._closeButtonXAlignConstraint = new Clutter.AlignConstraint({
        source: this._panel,
        align_axis: Clutter.AlignAxis.X_AXIS,
        pivot_point: new Graphene.Point({ x: 0.5, y: -1 })
      });
      this._closeButton.add_constraint(this._closeButtonXAlignConstraint);
      this._closeButton.connect('clicked', () => {
        this._close();
      });
      this._primaryMonitorBin.add_child(this._closeButton);

      this._areaSelector.connect('drag-started', () => {
        this._panel.ease({
          opacity: 100,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._closeButton.ease({
          opacity: 100,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
      });
      this._areaSelector.connect('drag-ended', () => {
        this._panel.ease({
          opacity: 255,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._closeButton.ease({
          opacity: 255,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
      });

      this._typeButtonContainer = new St.Widget({
        layout_manager: new Clutter.BoxLayout({
          spacing: 12,
          homogeneous: true
        })
      });
      this._panel.add_child(this._typeButtonContainer);

      this._selectionButton = new IconLabelButton(
        `${getIconsLocation().get_path()}/screenshot-ui-area-symbolic.svg`,
        _('Selection'),
        {
          style_class: 'pixzzle-ui-type-button',
          checked: true,
          x_expand: true
        }
      );
      this._selectionButton.connect(
        'notify::checked',
        this._onSelectionButtonToggled.bind(this)
      );
      this._typeButtonContainer.add_child(this._selectionButton);

      this.add_child(
        new UITooltip(this._selectionButton, {
          text: _('Area Selection'),
          style_class: 'pixzzle-ui-tooltip',
          visible: false
        })
      );

      this._screenButton = new IconLabelButton(
        `${getIconsLocation().get_path()}/screenshot-ui-display-symbolic.svg`,
        _('Screen'),
        {
          style_class: 'pixzzle-ui-type-button',
          toggle_mode: true,
          x_expand: true
        }
      );
      this._screenButton.connect(
        'notify::checked',
        this._onScreenButtonToggled.bind(this)
      );
      this._typeButtonContainer.add_child(this._screenButton);

      this.add_child(
        new UITooltip(this._screenButton, {
          text: _('Screen Selection'),
          style_class: 'pixzzle-ui-tooltip',
          visible: false
        })
      );

      this._bottomRowContainer = new St.Widget({
        layout_manager: new Clutter.BinLayout()
      });
      this._panel.add_child(this._bottomRowContainer);

      this._captureButton = new St.Button({
        style_class: 'pixzzle-ui-capture-button'
      });
      this._captureButton.set_child(
        new St.Widget({ style_class: 'pixzzle-ui-capture-button-circle' })
      );
      this.add_child(
        new UITooltip(this._captureButton, {
          /* Translators: since this string refers to an action,
    it needs to be phrased as a verb. */
          text: _('Capture'),
          style_class: 'pixzzle-ui-tooltip',
          visible: false
        })
      );
      this._captureButton.connect(
        'clicked',
        this._onCaptureButtonClicked.bind(this)
      );
      this._bottomRowContainer.add_child(this._captureButton);

      this._ocrActionBox = new St.Widget({
        x_align: Clutter.ActorAlign.FILL,
        x_expand: true,
        layout_manager: new Clutter.BoxLayout({
          spacing: 10,
          homogeneous: true
        })
      });
      this._bottomRowContainer.add_child(this._ocrActionBox);

      this._expandButton = new IconLabelButton(
        `${getIconsLocation().get_path()}/screenshot-ui-expand-symbolic.png`,
        _('Expand'),
        {
          style_class: 'pixzzle-ui-expand-button',
          x_align: Clutter.ActorAlign.START,
          x_expand: true
        }
      );
      this._expandButton.connect('clicked', () =>
        this._areaSelector.expandHandles()
      );
      this.add_child(
        new UITooltip(this._expandButton, {
          text: _('Expand drag edges'),
          style_class: 'pixzzle-ui-tooltip',
          visible: false
        })
      );
      this._ocrActionBox.add_child(this._expandButton);

      const iconName = 'pixzzle-ui-ocr-action-symbolic.svg';
      this._ocrActionButton = new St.Button({
        style_class: 'pixzzle-ui-ocr-action-button',
        child: new St.Icon({
          gicon: Gio.icon_new_for_string(
            `${getIconsLocation().get_path()}/${iconName}`
          ),
          style_class: 'pixzzle-ui-ocr-action-icon'
        }),
        toggle_mode: true
      });
      this._ocrActionBox.add_child(this._ocrActionButton);

      this._ocrActionButton = new IconLabelButton(
        `${getIconsLocation().get_path()}/pixzzle-ui-ocr-action-symbolic.png`,
        _('Extract'),
        {
          style_class: 'pixzzle-ui-ocr-action-button',
          x_align: Clutter.ActorAlign.END,
          x_expand: true,
          toggle_mode: true
        }
      );
      this._ocrActionBox.add_child(this._ocrActionButton);
      this.add_child(
        new UITooltip(this._ocrActionButton, {
          text: _('Perform OCR'),
          style_class: 'pixzzle-ui-tooltip',
          visible: false
        })
      );

      this._monitorBins = [];
      this._rebuildMonitorBins();
      this.monitorChangeID = Main.layoutManager.connect(
        'monitors-changed',
        () => {
          this._close(true);
          this._rebuildMonitorBins();
        }
      );

      const uiModes = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;
      this.sessionUpdateID = Main.sessionMode.connect('updated', () =>
        this._sessionUpdated()
      );
      this._sessionUpdated();

      this.connect('destroy', this._onDestroy.bind(this));
    }

    _showUI() {
      this._open().catch((err) => {
        logError(
          err,
          format('UIShutter::_showUI', 'Error opening the screenshot UI')
        );
      });
    }

    _reload_theme() {
      const theme_context = St.ThemeContext.get_for_stage(global.stage);
      const theme = theme_context.get_theme();
      if (!theme) return;

      let stylesheet = Me.dir.get_child('stylesheet.css');

      theme.unload_stylesheet(stylesheet);
      theme.load_stylesheet(stylesheet);
      theme_context.set_theme(theme);
    }

    _onDestroy() {
      Main.sessionMode.disconnect(this.sessionUpdateID);
      Main.layoutManager.disconnect(this.monitorChangeID);
      Main.layoutManager.removeChrome(this._screenshotUIGroup);
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
    }

    _sessionUpdated() {
      this._close(true);
    }

    _refreshButtonLayout() {
      const buttonLayout = Meta.prefs_get_button_layout();

      this._closeButton.remove_style_class_name('left');
      this._closeButton.remove_style_class_name('right');

      if (buttonLayout.left_buttons.includes(Meta.ButtonFunction.CLOSE)) {
        this._closeButton.add_style_class_name('left');
        this._closeButtonXAlignConstraint.factor = 0;
      } else {
        this._closeButton.add_style_class_name('right');
        this._closeButtonXAlignConstraint.factor = 1;
      }
    }

    _rebuildMonitorBins() {
      for (const bin of this._monitorBins) bin.destroy();

      this._monitorBins = [];
      this._screenSelectors = [];

      for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
        const bin = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        bin.add_constraint(new Layout.MonitorConstraint({ index: i }));
        this.insert_child_below(bin, this._primaryMonitorBin);
        this._monitorBins.push(bin);

        const screenSelector = new St.Button({
          style_class: 'pixzzle-ui-screen-selector',
          x_expand: true,
          y_expand: true,
          visible: this._screenButton.checked,
          reactive: true,
          can_focus: true,
          toggle_mode: true
        });
        screenSelector.connect('key-focus-in', () => {
          this.grab_key_focus();
          screenSelector.checked = true;
        });
        bin.add_child(screenSelector);
        this._screenSelectors.push(screenSelector);

        screenSelector.connect('notify::checked', () => {
          if (!screenSelector.checked) return;

          screenSelector.toggle_mode = false;
          for (const otherSelector of this._screenSelectors) {
            if (screenSelector === otherSelector) continue;

            otherSelector.toggle_mode = true;
            otherSelector.checked = false;
          }
        });
      }

      if (Main.layoutManager.primaryIndex !== -1)
        this._screenSelectors[Main.layoutManager.primaryIndex].checked = true;
    }

    async _open() {
      lg('Open::called');
      if (this._openingCoroutineInProgress) return;

      if (!this.visible) {
        this._shooter = new Shell.Screenshot();

        this._openingCoroutineInProgress = true;
        try {
          const [content, scale, cursorContent, cursorPoint, cursorScale] =
            await this._shooter.screenshot_stage_to_content();
          this._stageScreenshot.set_content(content);
          this._scale = scale;

          this._stageScreenshotContainer.show();
        } catch (e) {
          log(`Error capturing screenshot: ${e.message}`);
        }
        this._openingCoroutineInProgress = false;
      }

      // Get rid of any popup menus.
      // We already have them captured on the screenshot anyway.
      //
      // This needs to happen before the grab below as closing menus will
      // pop their grabs.
      Main.layoutManager.emit('system-modal-opened');

      // this.screenshotUIGroup.get_parent().set_child_above_sibling(
      //   this.screenshotUIGroup, null);

      const grabResult = this._grabHelper.grab({
        actor: this,
        onUngrab: () => this._close()
      });
      if (!grabResult) {
        this._close(true);
        return;
      }

      this._refreshButtonLayout();

      this.remove_all_transitions();
      this.visible = true;
      this.ease({
        opacity: 255,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._stageScreenshotContainer
            .get_parent()
            .remove_child(this._stageScreenshotContainer);
          this.insert_child_at_index(this._stageScreenshotContainer, 0);
        }
      });
    }

    _finishClosing() {
      this.hide();

      this._shooter = null;

      this._stageScreenshotContainer
        .get_parent()
        .remove_child(this._stageScreenshotContainer);
      Main.layoutManager.screenshotUIGroup.insert_child_at_index(
        this._stageScreenshotContainer,
        0
      );
      this._stageScreenshotContainer.hide();

      this._stageScreenshot.set_content(null);
      this._areaSelector.reset();
    }

    _close(instantly = false) {
      this._grabHelper.ungrab();

      if (instantly) {
        this.emit('begin-close');
        this._finishClosing();
        return;
      }

      this.emit('begin-close');
      this.remove_all_transitions();
      this.ease({
        opacity: 0,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: this._finishClosing.bind(this)
      });
    }

    _onSelectionButtonToggled() {
      if (this._selectionButton.checked) {
        this._selectionButton.toggle_mode = false;
        this._screenButton.checked = false;

        this._areaSelector.show();
        this._areaSelector.remove_all_transitions();
        this._areaSelector.reactive = true;
        this._areaSelector.ease({
          opacity: 255,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
      } else {
        this._selectionButton.toggle_mode = true;

        this._areaSelector.stopDrag();
        global.display.set_cursor(Meta.Cursor.DEFAULT);

        this._areaSelector.remove_all_transitions();
        this._areaSelector.reactive = false;
        this._areaSelector.ease({
          opacity: 0,
          duration: 200,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => this._areaSelector.hide()
        });
      }
    }

    _onScreenButtonToggled() {
      if (this._screenButton.checked) {
        this._screenButton.toggle_mode = false;
        this._selectionButton.checked = false;

        for (const selector of this._screenSelectors) {
          selector.show();
          selector.remove_all_transitions();
          selector.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
          });
        }
      } else {
        this._screenButton.toggle_mode = true;

        for (const selector of this._screenSelectors) {
          selector.remove_all_transitions();
          selector.ease({
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => selector.hide()
          });
        }
      }
    }

    _getSelectedGeometry(rescale) {
      let x, y, w, h;

      if (this._selectionButton.checked) {
        [x, y, w, h] = this._areaSelector.getGeometry();
      } else if (this._screenButton.checked) {
        const index = this._screenSelectors.findIndex(
          (screen) => screen.checked
        );
        const monitor = Main.layoutManager.monitors[index];

        x = monitor.x;
        y = monitor.y;
        w = monitor.width;
        h = monitor.height;
      }

      if (rescale) {
        x *= this._scale;
        y *= this._scale;
        w *= this._scale;
        h *= this._scale;
      }

      return [x, y, w, h];
    }

    _onCaptureButtonClicked() {
      this._saveScreenshot();
      this._close();
    }

    _saveScreenshot() {
      if (this._selectionButton.checked || this._screenButton.checked) {
        const content = this._stageScreenshot.get_content();
        if (!content) return; // Failed to capture the screenshot for some reason.

        const texture = content.get_texture();
        const geometry = this._getSelectedGeometry(true);

        this._captureScreenshot(texture, geometry, this._scale, {
          texture: null,
          x: this._scale,
          y: this._scale,
          scale: this._scale
        }).catch((e) => logError(e, 'Error capturing screenshot'));
      }
    }

    /**
     * Captures a screenshot from a texture, given a region, scale and optional
     * cursor data.
     *
     * @param {Cogl.Texture} texture - The texture to take the screenshot from.
     * @param {number[4]} [geometry] - The region to use: x, y, width and height.
     * @param {number} scale - The texture scale.
     * @param {object} [cursor] - Cursor data to include in the screenshot.
     * @param {Cogl.Texture} cursor.texture - The cursor texture.
     * @param {number} cursor.x - The cursor x coordinate.
     * @param {number} cursor.y - The cursor y coordinate.
     * @param {number} cursor.scale - The cursor texture scale.
     */
    async _captureScreenshot(texture, geometry, scale, cursor) {
      const stream = Gio.MemoryOutputStream.new_resizable();
      const [x, y, w, h] = geometry ?? [0, 0, -1, -1];
      if (cursor === null) cursor = { texture: null, x: 0, y: 0, scale: 1 };

      global.display
        .get_sound_player()
        .play_from_theme('screen-capture', _('Screenshot taken'), null);

      const pixbuf = await Shell.Screenshot.composite_to_stream(
        texture,
        x,
        y,
        w,
        h,
        scale,
        cursor.texture,
        cursor.x,
        cursor.y,
        cursor.scale,
        stream
      );

      stream.close(null);
      const filename = storeScreenshot(stream.steal_as_bytes(), pixbuf);
      this.emit('new-shot', {
        name: filename,
        ocr: this._ocrActionButton.checked
      });
    }

    vfunc_key_press_event(event) {
      const symbol = event.keyval;
      if (
        symbol === Clutter.KEY_Return ||
        symbol === Clutter.KEY_space ||
        (event.modifier_state & Clutter.ModifierType.CONTROL_MASK &&
          (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C))
      ) {
        this._onCaptureButtonClicked();
        return Clutter.EVENT_STOP;
      }

      if (symbol === Clutter.KEY_s || symbol === Clutter.KEY_S) {
        this._selectionButton.checked = true;
        return Clutter.EVENT_STOP;
      }

      if (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C) {
        this._screenButton.checked = true;
        return Clutter.EVENT_STOP;
      }

      if (symbol === Clutter.KEY_p || symbol === Clutter.KEY_P) {
        this._ocrActionButton.checked = !this._ocrActionButton.checked;
        return Clutter.EVENT_STOP;
      }

      if (
        symbol === Clutter.KEY_Left ||
        symbol === Clutter.KEY_Right ||
        symbol === Clutter.KEY_Up ||
        symbol === Clutter.KEY_Down
      ) {
        let direction;
        if (symbol === Clutter.KEY_Left) direction = St.DirectionType.LEFT;
        else if (symbol === Clutter.KEY_Right)
          direction = St.DirectionType.RIGHT;
        else if (symbol === Clutter.KEY_Up) direction = St.DirectionType.UP;
        else if (symbol === Clutter.KEY_Down) direction = St.DirectionType.DOWN;

        if (this._screenButton.checked) {
          lg('vfunc_key_press_event::_screenSelectors:', this._screenSelectors);
          const screen =
            this._screenSelectors.find((selector) => selector.checked) ?? null;
          this.navigate_focus(screen, direction, false);
        }

        return Clutter.EVENT_STOP;
      }

      return super.vfunc_key_press_event(event);
    }
  }
);
