/* panel.js
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

const Main = imports.ui.main;

function computePanelPosition() {
  const invisible = {x : 0, y : 0, width : 0, height : 0};
  if (Main.layoutManager.primaryIndex === -1) {
    return invisible;
  }

  const monitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex];
  const panel = Main.panel;
  const isTop = panel.x === monitor.x && panel.width === monitor.width;
  const isRight = panel.x > monitor.x && panel.height === monitor.height;
  const isBottom = panel.y > monitor.y && panel.width === monitor.width;
  const isLeft = panel.x === monitor.x && panel.height === monitor.height;

  return {
    Top : isTop ? panel : invisible,
    Right : isRight ? panel : invisible,
    Bottom : isBottom ? panel : invisible,
    Left : isLeft ? panel : invisible
  };
}
