const {Gio} = imports.gi;
    
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var SCHEMA_NAME = 'org.gnome.shell.extensions.pixzzle';
var SCREENSHOT_KEY = 'take-screenshot';

const debug = true;
function lg() {
  if (debug) {
    log('[' + SCHEMA_NAME + '] ', ...arguments);
  }
}

const inflateSettings = function() {
  let schemaDir = Me.dir.get_child('schemas').get_path();
  let schemaSource = Gio.SettingsSchemaSource.new_from_directory(
      schemaDir, Gio.SettingsSchemaSource.get_default(), false);
  let schema = schemaSource.lookup(SCHEMA_NAME, false);

  return new Gio.Settings({settings_schema : schema});
};
