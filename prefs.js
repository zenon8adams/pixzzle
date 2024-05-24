/* prefs.js
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

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Gettext = imports.gettext;
const _ = Gettext.domain('pixzzle').gettext;

const { inflateSettings, SCHEMA_NAME, lg, SCREENSHOT_KEY, SHOT_STORE } =
  Me.imports.utils;

var Fields = {
  TOGGLE_VISIBILITY: 'toggle-visibility',
  OPEN_SHUTTER: 'open-shutter',
  MAIN_BG_COLOR: 'main-bg-color',
  THUMBNAIL_BG_COLOR: 'thumbnail-bg-color',
  SHOTBUTTON_BG_COLOR: 'shotbutton-bg-color',
  SHOTBUTTON_FG_COLOR: 'shotbutton-fg-color',
  SWAP_VIEWS: 'swap-views',
  NATURAL_PANNING: 'natural-panning',
  OCR_API: 'ocr-api'
};

const COLUMN_ID = 0;
const COLUMN_DESCRIPTION = 1;
const COLUMN_KEY = 2;
const COLUMN_MODS = 3;

function init() {
  ExtensionUtils.initTranslations();
}

const SettingsApp = GObject.registerClass(
  class SettingsApp extends GObject.Object {
    _init() {
      this.main = new Gtk.Grid({
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 10,
        margin_end: 10,
        row_spacing: 12,
        column_spacing: 18,
        column_homogeneous: false,
        row_homogeneous: false
      });

      const SettingsSchema = inflateSettings();

      this.field_main_bg_color = new Gtk.ColorButton({
        use_alpha: true,
        rgba: buildColor(SettingsSchema.get_strv(Fields.MAIN_BG_COLOR))
      });
      this.field_main_bg_color.set_size_request(
        150,
        this.field_main_bg_color.get_height()
      );
      this.field_main_bg_color.connect('color-set', (button) => {
        SettingsSchema.set_value(
          Fields.MAIN_BG_COLOR,
          GLib.Variant.new_strv(splitColor(button.rgba))
        );
      });

      this.field_thumbnail_bg_color = new Gtk.ColorButton({
        use_alpha: true,
        rgba: buildColor(SettingsSchema.get_strv(Fields.THUMBNAIL_BG_COLOR))
      });
      this.field_thumbnail_bg_color.connect('color-set', (button) => {
        SettingsSchema.set_value(
          Fields.THUMBNAIL_BG_COLOR,
          GLib.Variant.new_strv(splitColor(button.rgba))
        );
      });

      this.field_shot_button_bg_color = new Gtk.ColorButton({
        rgba: buildColor(SettingsSchema.get_strv(Fields.SHOTBUTTON_BG_COLOR))
      });
      this.field_shot_button_bg_color.connect('color-set', (button) => {
        SettingsSchema.set_value(
          Fields.SHOTBUTTON_BG_COLOR,
          GLib.Variant.new_strv(splitColor(button.rgba))
        );
      });

      this.field_shot_button_fg_color = new Gtk.ColorButton({
        rgba: buildColor(SettingsSchema.get_strv(Fields.SHOTBUTTON_FG_COLOR))
      });
      this.field_shot_button_fg_color.connect('color-set', (button) => {
        SettingsSchema.set_value(
          Fields.SHOTBUTTON_FG_COLOR,
          GLib.Variant.new_strv(splitColor(button.rgba))
        );
      });

      this.field_swap_views = new Gtk.ComboBox({
        active: SettingsSchema.get_int(Fields.SWAP_VIEWS),
        model: this._create_swap_selector_options()
      });
      const rendererText = new Gtk.CellRendererText();
      this.field_swap_views.pack_start(rendererText, false);
      this.field_swap_views.add_attribute(rendererText, 'text', 0);
      this.field_swap_views.connect('changed', (box) =>
        SettingsSchema.set_int(Fields.SWAP_VIEWS, box.active)
      );

      this.field_natural_panning = new Gtk.Switch({
        active: SettingsSchema.get_boolean(Fields.NATURAL_PANNING)
      });
      this.field_natural_panning.connect('state-set', (toggler, state) => {
        SettingsSchema.set_boolean(Fields.NATURAL_PANNING, state);
        toggler.active = state;
      });

      this.field_ocr_api_key = new Gtk.Entry({
        text: SettingsSchema.get_string(Fields.OCR_API)
      });
      this.field_ocr_api_key.connect('changed', (box) => {
        SettingsSchema.set_string(Fields.OCR_API, box.text);
      });

      this.field_keybinding = createKeybindingWidget(SettingsSchema);
      this.binding_rows = {};

      this.binding_rows[Fields.TOGGLE_VISIBILITY] = addKeybinding(
        this.field_keybinding.model,
        SettingsSchema,
        Fields.TOGGLE_VISIBILITY,
        _('Toggle shot manager')
      );

      this.binding_rows[Fields.OPEN_SHUTTER] = addKeybinding(
        this.field_keybinding.model,
        SettingsSchema,
        Fields.OPEN_SHUTTER,
        _('Open shutter')
      );

      this.reset_button = new Gtk.Button({
        hexpand: true,
        halign: Gtk.Align.END,
        icon_name: 'edit-undo-symbolic'
      });

      this.reset_button.get_style_context().add_class('circular');
      this.reset_button.connect('clicked', () => {
        Object.values(Fields).forEach((id) => SettingsSchema.reset(id));
        this.field_swap_views.active = SettingsSchema.get_int(
          Fields.SWAP_VIEWS
        );
        this.field_natural_panning.active = SettingsSchema.get_boolean(
          Fields.NATURAL_PANNING
        );
        this.field_main_bg_color.rgba = buildColor(
          SettingsSchema.get_strv(Fields.MAIN_BG_COLOR)
        );
        this.field_thumbnail_bg_color.rgba = buildColor(
          SettingsSchema.get_strv(Fields.THUMBNAIL_BG_COLOR)
        );
        this.field_shot_button_bg_color.rgba = buildColor(
          SettingsSchema.get_strv(Fields.SHOTBUTTON_BG_COLOR)
        );
        this.field_shot_button_fg_color.rgba = buildColor(
          SettingsSchema.get_strv(Fields.SHOTBUTTON_FG_COLOR)
        );
        resetKeybinding(
          this.field_keybinding,
          SettingsSchema,
          Fields.TOGGLE_VISIBILITY,
          this.binding_rows
        );
        resetKeybinding(
          this.field_keybinding,
          SettingsSchema,
          Fields.OPEN_SHUTTER,
          this.binding_rows
        );
      });

      const mainBGColor = new Gtk.Label({
        label: _('Choose a contrasting background color'),
        hexpand: true,
        halign: Gtk.Align.START
      });
      const thumbnailBGColor = new Gtk.Label({
        label: _('Choose background color for your thumbnails'),
        hexpand: true,
        halign: Gtk.Align.START
      });
      const shotButtonBGColor = new Gtk.Label({
        label: _('Choose background color for screenshot button'),
        hexpand: true,
        halign: Gtk.Align.START
      });
      const shotButtonFGColor = new Gtk.Label({
        label: _('Choose foreground color for screenshot button'),
        hexpand: true,
        halign: Gtk.Align.START
      });
      const swapViewsLabel = new Gtk.Label({
        label: _('Swap main view layout'),
        hexpand: true,
        halign: Gtk.Align.START
      });

      const naturalPanLabel = new Gtk.Label({
        label: _('Set drag direction of image viewer (natural panning)'),
        hexpand: true,
        halign: Gtk.Align.START
      });

      const ocrKeyLabel = new Gtk.Label({
        label: _('Set up `ocr-space` API KEY'),
        hexpand: true,
        halign: Gtk.Align.START
      });

      const bindWarningLabel = new Gtk.Label({
        hexpand: true,
        halign: Gtk.Align.END
      });
      bindWarningLabel.set_markup(
        `<span foreground="red" font_size="small"><i>` +
          `${_('You cannot bind to `Ctrl+R`, `Ctrl+L` or `O`')}</i></span>`
      );

      const addRow = ((main) => {
        let row = 0;
        return (label, input) => {
          let inputWidget = input;

          if (input instanceof Gtk.Switch) {
            inputWidget = new Gtk.Box({
              orientation: Gtk.Orientation.HORIZONTAL
            });
            inputWidget.append(input);
          }

          if (label) {
            main.attach(label, 0, row, 1, 1);
            main.attach(inputWidget, 1, row, 1, 1);
          } else {
            main.attach(inputWidget, 0, row, 2, 1);
          }

          row++;
        };
      })(this.main);

      addRow(mainBGColor, this.field_main_bg_color);
      addRow(thumbnailBGColor, this.field_thumbnail_bg_color);
      addRow(shotButtonBGColor, this.field_shot_button_bg_color);
      addRow(shotButtonFGColor, this.field_shot_button_fg_color);
      addRow(swapViewsLabel, this.field_swap_views);
      addRow(naturalPanLabel, this.field_natural_panning);
      addRow(ocrKeyLabel, this.field_ocr_api_key);
      addRow(null, this.field_keybinding);
      addRow(null, bindWarningLabel);
      addRow(null, this.reset_button);
    }

    _create_swap_selector_options() {
      const options = [{ name: _('Left') }, { name: _('Right') }];
      const liststore = new Gtk.ListStore();
      liststore.set_column_types([GObject.TYPE_STRING]);
      for (let i = 0; i < options.length; ++i) {
        const option = options[i];
        const iter = liststore.append();
        liststore.set(iter, [0], [option.name]);
      }
      return liststore;
    }
  }
);

function buildColor(code) {
  const [red, green, blue, alpha] = code.map((c) => parseFloat(c));
  return new Gdk.RGBA({
    red: red,
    green: green,
    blue: blue,
    alpha: alpha
  });
}

function splitColor(code) {
  return [code.red, code.green, code.blue, code.alpha].map((value) =>
    value.toFixed(2).toString()
  );
}

function buildPrefsWidget() {
  const widget = new SettingsApp();
  return widget.main;
}

function addKeybinding(model, settings, id, description) {
  let accelerator = settings.get_strv(id)[0];
  let key, mods;
  if (accelerator == null) [key, mods] = [0, 0];
  else [, key, mods] = Gtk.accelerator_parse(settings.get_strv(id)[0]);

  const row = model.insert(0);
  model.set(
    row,
    [COLUMN_ID, COLUMN_DESCRIPTION, COLUMN_KEY, COLUMN_MODS],
    [id, description, key, mods]
  );

  return row;
}

function resetKeybinding(view, settings, id, bindings) {
  const entry = bindings[id];
  const model = view.get_model();
  const sequence = settings.get_strv(id)[0];
  const [, key, mods] = Gtk.accelerator_parse(sequence);
  model.set(entry, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
}

function createKeybindingWidget(SettingsSchema) {
  let model = new Gtk.ListStore();

  model.set_column_types([
    GObject.TYPE_STRING, // COLUMN_ID
    GObject.TYPE_STRING, // COLUMN_DESCRIPTION
    GObject.TYPE_INT, // COLUMN_KEY
    GObject.TYPE_INT
  ]); // COLUMN_MODS

  let treeView = new Gtk.TreeView();
  treeView.model = model;
  treeView.headers_visible = false;

  let column, renderer;

  renderer = new Gtk.CellRendererText();

  column = new Gtk.TreeViewColumn();
  column.expand = true;
  column.pack_start(renderer, true);
  column.add_attribute(renderer, 'text', COLUMN_DESCRIPTION);

  treeView.append_column(column);

  renderer = new Gtk.CellRendererAccel();
  renderer.accel_mode = Gtk.CellRendererAccelMode.GTK;
  renderer.editable = true;

  renderer.connect(
    'accel-edited',
    function (renderer, path, key, mods, hwCode) {
      let [ok, iter] = model.get_iter_from_string(path);
      if (!ok) return;

      const id = model.get_value(iter, COLUMN_ID);
      const accelString = Gtk.accelerator_name(key, mods);
      if (!isInternalControlCode(id, accelString)) {
        model.set(iter, [COLUMN_KEY, COLUMN_MODS], [key, mods]);
        SettingsSchema.set_strv(id, [accelString]);
      }
    }
  );

  renderer.connect('accel-cleared', function (renderer, path) {
    let [ok, iter] = model.get_iter_from_string(path);
    if (!ok) return;

    model.set(iter, [COLUMN_KEY, COLUMN_MODS], [0, 0]);
    const id = model.get_value(iter, COLUMN_ID);
    SettingsSchema.set_strv(id, []);
  });

  column = new Gtk.TreeViewColumn();
  column.pack_end(renderer, false);
  column.add_attribute(renderer, 'accel-key', COLUMN_KEY);
  column.add_attribute(renderer, 'accel-mods', COLUMN_MODS);

  treeView.append_column(column);

  return treeView;
}

const INTERNAL_CONTROL_TABLE = ['<Control>r', '<Control>l', 'o', 'O'];
function isInternalControlCode(id, accel) {
  lg('[Prefs.js::isInternalControlCode]', 'accel:', accel);
  return INTERNAL_CONTROL_TABLE.indexOf(accel) !== -1;
}
