/* dialog.js
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

const { GObject, GLib, Clutter, St, Shell } = imports.gi;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { lg, Constants } = Me.imports.utils;

let _modalDialog = null;

var ModalReply = {
  OKAY: 0,
  CANCEL: 1
};
var UIDialog = GObject.registerClass(
  {
    Properties: {
      anchor: GObject.ParamSpec.object(
        'anchor',
        'anchor',
        'anchor',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
        St.Widget.$gtype
      ),
      overlay: GObject.ParamSpec.object(
        'overlay',
        'overlay',
        'overlay',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
        St.Widget.$gtype
      )
    }
  },
  class UIDialog extends St.Widget {
    _init(params) {
      super._init({
        ...params,
        name: 'UIDialog',
        reactive: true,
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL
        })
      });

      this._headerContainer = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        y_expand: false
      });
      this.add_child(this._headerContainer);

      this._headerText = new St.Label({
        style_class: 'pixzzle-ui-dialog-header-text',
        text: 'Confirmation',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: false
      });
      this._headerContainer.add_child(this._headerText);

      this._dialogExit = new St.Button({
        style_class: 'pixzzle-ui-dialog-exit-button',
        child: new St.Icon({ icon_name: 'preview-close-symbolic' }),
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false
      });
      this._headerContainer.add_child(this._dialogExit);

      this._separator = new St.Widget({
        style_class: 'pixzzle-ui-dialog-separator',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        height: 1
      });
      this.add_child(this._separator);

      this._content = new St.Label({
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL
      });
      this.add_child(this._content);

      this._spacing = new St.Widget({
        x_expand: true,
        y_expand: true,
        height: 40
      });
      this.add_child(this._spacing);

      this._buttonBox = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        y_expand: false,
        x_align: Clutter.ActorAlign.END
      });
      this.add_child(this._buttonBox);

      this._acceptButton = new St.Button({
        label: 'Yes',
        style_class: 'pixzzle-ui-dialog-accept-button',
        x_align: Clutter.ActorAlign.END
      });
      this._buttonBox.add_child(this._acceptButton);

      this._cancelButton = new St.Button({
        label: 'No',
        style_class: 'pixzzle-ui-dialog-cancel-button',
        x_align: Clutter.ActorAlign.END
      });
      this._buttonBox.add_child(this._cancelButton);

      this._timeoutId = null;

      this.set_width(400);

      this.anchor.connect('destroy', this._onDestroy.bind(this));
      this._acceptButton.connect('clicked', () => this.close(ModalReply.OKAY));
      this._dialogExit.connect('clicked', () => this.close(ModalReply.CANCEL));
      this._cancelButton.connect('clicked', () =>
        this.close(ModalReply.CANCEL)
      );
    }

    display(dialogue, cb) {
      const { ok, cancel, header, prompt } = dialogue;
      ok && this._acceptButton.set_label(ok);
      cancel && this._cancelButton.set_label(cancel);
      header && this._headerText.set_text(header);
      prompt && this._content.set_text(prompt);

      this._replyFn = cb;
      this.open();
    }

    open() {
      if (this._timeoutId) return;
      this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this.opacity = 0;
        this.show();

        const extents = this.anchor.get_transformed_extents();
        const xOffset = Math.floor((extents.get_width() - this.width) / 2);
        const yOffset = Math.floor((extents.get_height() - this.height) / 2);

        this.set_position(this.anchor.x + xOffset, this.anchor.y + yOffset);
        this.ease({
          opacity: Constants.FULLY_OPAQUE,
          duration: 150,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          onComplete: () => {
            this.overlay._open();
          }
        });

        this._timeoutId = null;
        return GLib.SOURCE_REMOVE;
      });
      GLib.Source.set_name_by_id(this._timeoutId, '[pixzzle] dialog.open');
    }

    close(status) {
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
        onComplete: () => {
          this.hide();
          this.overlay._close();
          this._replyFn?.(status);
        }
      });
    }

    _onDestroy() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      _modalDialog = null;

      Main.layoutManager.removeChrome(this);
    }

    vfunc_key_press_event(event) {
      const symbol = event.keyval;
      lg('[UIDialog::vfunc_key_press_event] keycode:', symbol);
      if (symbol === Clutter.KEY_Return) {
        this.close(ModalReply.OKAY);
      lg('[UIDialog::vfunc_key_press_event] enter pressed');
      } else if (symbol === Clutter.KEY_Escape) {
        this.close(ModalReply.CANCEL);
      }
      return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
      return Clutter.EVENT_STOP;
    }
  }
);

function makeModal(params = null) {
  if (!_modalDialog && params) {
    _modalDialog = new UIDialog(params);
  } else if (!params) {
    throw new Error('Unable to create dialog: Empty parameter set');
  }

  return _modalDialog;
}

function getDialog() {
  if (!_modalDialog) {
    throw new Error('Invalid function call. Call makeModal() first.');
  }

  return _modalDialog;
}
