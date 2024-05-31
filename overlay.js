/* overlay.js
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

const { Clutter, GObject, GLib, Shell, St } = imports.gi;

const GrabHelper = imports.ui.grabHelper;
const Main = imports.ui.main;
const Layout = imports.ui.layout;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext.domain(Me.metadata['gettext-domain']);
const _ = Gettext.gettext;

const Dialog = Me.imports.dialog;
const { lg, format } = Me.imports.utils;

var UIOverlay = GObject.registerClass(
  class UIOverlay extends St.Widget {
    _init(anchor) {
      super._init({
        name: 'Overlay',
        constraints: new Clutter.BindConstraint({
          source: global.stage,
          coordinate: Clutter.BindCoordinate.ALL
        }),
        layout_manager: new Clutter.BinLayout(),
        visible: false,
        reactive: true
      });

      this._anchor = anchor;

      this._stageOverlay = new St.Widget({ visible: false });
      this._stageOverlay.add_constraint(
        new Clutter.BindConstraint({
          source: global.stage,
          coordinate: Clutter.BindCoordinate.ALL
        })
      );

      this._overlayUIGroup = new St.Widget({
        layout_manager: new Clutter.BinLayout()
      });
      Main.layoutManager.addTopChrome(this._overlayUIGroup);

      this._overlayUIGroup.add_child(this._stageOverlay);

      this._overlayUIGroup.add_child(this);

      this._grabHelper = new GrabHelper.GrabHelper(this, {
        actionMode: Shell.ActionMode.POPUP
      });

      this._modal = Dialog.makeModal({
        anchor: this._anchor,
        overlay: this,
        visible: false
      });
      this.add_child(this._modal);

      this._primaryMonitorBin = new St.Widget({
        layout_manager: new Clutter.BinLayout()
      });
      this._primaryMonitorBin.add_constraint(
        new Layout.MonitorConstraint({ primary: true })
      );
      this.add_child(this._primaryMonitorBin);

      this._monitorBins = [];
      this._rebuildMonitorBins();
      this._monitorChangeID = Main.layoutManager.connect(
        'monitors-changed',
        () => {
          this._close();
          this._rebuildMonitorBins();
        }
      );

      const uiModes = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;
      this.sessionUpdateID = Main.sessionMode.connect('updated', () =>
        this._sessionUpdated()
      );
      this._sessionUpdated();

      this._anchor.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
      Main.sessionMode.disconnect(this.sessionUpdateID);
      Main.layoutManager.disconnect(this._monitorChangeID);
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      Main.layoutManager.removeChrome(this._overlayUIGroup);
    }

    _sessionUpdated() {
      this._close();
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
      }
    }

    _open() {
      this._stageOverlay.show();
      Main.layoutManager.emit('system-modal-opened');

      const grabResult = this._grabHelper.grab({
        actor: this,
        onUngrab: () => this._close()
      });
      if (!grabResult) {
        this._close(true);
        return;
      }

      this.remove_all_transitions();
      this.visible = true;
      this._stageOverlay.get_parent().remove_child(this._stageOverlay);
      this.insert_child_at_index(this._stageOverlay, 0);
    }

    _close() {
      this._grabHelper.ungrab();
      this.hide();
      this._stageOverlay.get_parent().remove_child(this._stageOverlay);
      Main.layoutManager.uiGroup.insert_child_at_index(this._stageOverlay, 0);
    }

    _cycleFocus() {
      this._focusButton = ((this._focusButton ?? 1) + 1) % 2;
      this._modal._cycleFocus(this._focusButton);
    }

    vfunc_key_press_event(event) {
      const symbol = event.keyval;
      if (symbol === Clutter.KEY_Return) {
        this._modal.close(this._focusButton);
      } else if (symbol === Clutter.KEY_Escape) {
        this._modal.close(Dialog.ModalReply.CANCEL);
      } else if (symbol === Clutter.KEY_Tab) {
        this._cycleFocus();
      }

      return Clutter.EVENT_STOP;
    }
  }
);
