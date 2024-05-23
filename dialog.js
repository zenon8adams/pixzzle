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

const { GObject, Gio, GLib, Clutter, St, Shell } = imports.gi;
const Main = imports.ui.main;
const Animator = imports.ui.animation;

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

      /* If we are given an icon, use it. */
      this._headerIcon = null;

      this._headerText = new St.Label({
        style_class: 'pixzzle-ui-dialog-header-text',
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

      this._tipsBox = new St.Widget({
        x_expand: true,
        y_expand: true
      });
      this.add_child(this._tipsBox);

      this._tips = new St.Label({
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        visible: false
      });
      this._tips.clutter_text.set_use_markup(true);
      this._tipsBox.add_child(this._tips);

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
      /* Set default focus button to accept button */
      this._cycleFocus(ModalReply.CANCEL);

      this.anchor.connect('destroy', this._onDestroy.bind(this));
      this._acceptButton.connect('clicked', () => this.close(ModalReply.OKAY));
      this._dialogExit.connect('clicked', () => this.close(ModalReply.CANCEL));
      this._cancelButton.connect('clicked', () =>
        this.close(ModalReply.CANCEL)
      );
    }

    display(dialogue, cb) {
      const { ok, cancel, icon, header, prompt, tips } = dialogue;
      if (!this._headerIcon && icon) {
        this._headerIcon = new UIIcon(icon);
        this._headerContainer.insert_child_at_index(this._headerIcon, 0);
      } else if (icon) {
        this._headerIcon.replace(icon);
      }
      ok && this._acceptButton.set_label(ok);
      cancel && this._cancelButton.set_label(cancel);
      header && this._headerText.set_text(header);
      prompt && this._content.set_text(prompt);
      this._setTip(tips);

      this._replyFn = cb;
      this.open();
    }

    open() {
      if (this._timeoutId) return;
      this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        this.opacity = 0;
        this.show();
        this._headerIcon.open();

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
          this._headerIcon.close();
          this.overlay._close();
          this._replyFn?.(status);
        }
      });
    }

    _cycleFocus(button) {
      if (button === ModalReply.OKAY) {
        this._acceptButton.remove_style_class_name('focus');
        this._acceptButton.add_style_class_name('focus');
        this._cancelButton.remove_style_class_name('focus');
      } else if (button === ModalReply.CANCEL) {
        this._cancelButton.remove_style_class_name('focus');
        this._cancelButton.add_style_class_name('focus');
        this._acceptButton.remove_style_class_name('focus');
      }
    }

    _setTip(info) {
      this._tips.visible = !!info;
      if (!info) {
        this._tipsBox.set_height(40);
        return;
      }
      this._tipsBox.set_height(-1);

      let tip = '\n';
      tip += info;
      tip += '\n';
      this._tips.clutter_text.set_markup(tip);
    }

    _onDestroy() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }
      _modalDialog = null;
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

const UIIcon = GObject.registerClass(
  {
    Properties: {
      animatable: GObject.ParamSpec.boolean(
        'animatable',
        'animatable',
        'animatable',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        false
      ),
      system_icon: GObject.ParamSpec.boolean(
        'system_icon',
        'system_icon',
        'system_icon',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        false
      ),
      icon_name: GObject.ParamSpec.string(
        'icon_name',
        'icon_name',
        'icon_name',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        null
      ),
      size: GObject.ParamSpec.int64(
        'size',
        'size',
        'size',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        0,
        Number.MAX_SAFE_INTEGER,
        0
      ),
      rate: GObject.ParamSpec.int64(
        'rate',
        'rate',
        'rate',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        0,
        Number.MAX_SAFE_INTEGER,
        0
      )
    }
  },
  class UIIcon extends St.Widget {
    _init(params) {
      super._init(params);

      this.create();
    }

    replace(new_icon) {
      if (new_icon.icon_name === this.icon_name) {
        return;
      }

      this.icon_name = new_icon.icon_name;
      this.animatable = !!new_icon.animatable;
      this.system_icon = !!new_icon.system_icon;
      this.size = new_icon.size;
      this.rate = new_icon.rate;
      this.remove_child(this._icon);
      this.create();
    }

    create() {
      if (!this.icon_name) {
        return;
      }

      const BASE_PATH = `${Me.path}/assets/icons/`;
      if (this.animatable) {
        this._icon = new Animator.Animation(
          Gio.File.new_for_path(`${BASE_PATH}/${this.icon_name}`),
          this.size,
          this.size,
          this.rate
        );
      } else if (this.system_icon) {
        this._icon = new St.Icon({
          icon_name: this.icon_name
        });
      } else {
        this._icon = new St.Icon({
          gicon: Gio.icon_new_for_string(`${BASE_PATH}/${this.icon_name}`)
        });
      }
      this.add_child(this._icon);
    }

    open() {
      if (this.animatable) {
        this.play();
      }
    }

    close() {
      if (this.animatable) {
        this.pause();
      }
    }

    play() {
      if (!this.animatable) {
        throw new Error('Error calling play() on non-animatable icon');
      }
      this._icon.play();
    }

    pause() {
      if (!this.animatable) {
        throw new Error('Error calling pause() on non-animatable icon');
      }
      this._icon.stop();
    }
  }
);
