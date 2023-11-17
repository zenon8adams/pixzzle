const { Gio, GLib } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

var SCHEMA_NAME = 'org.gnome.shell.extensions.pixzzle';
var SCREENSHOT_KEY = 'take-screenshot';

const debug = true;
function lg() {
  if (debug) {
    log('[' + SCHEMA_NAME + '] ' + Array.from(arguments).join(', '));
  }
}

function format() {
  const vicinity = arguments[0];
  const actualArgs = Array.from(arguments).slice(1);
  return (
    '[' + SCHEMA_NAME + '] ' + '[' + vicinity + '] ' + actualArgs.join(' ')
  );
}

function inflateSettings() {
  let schemaDir = Me.dir.get_child('schemas').get_path();
  let schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir,
    Gio.SettingsSchemaSource.get_default(),
    false
  );
  let schema = schemaSource.lookup(SCHEMA_NAME, false);

  return new Gio.Settings({ settings_schema: schema });
}

const _getShotStore = function () {
  const path = Gio.File.new_for_path(
    GLib.build_filenamev(Array.from(arguments))
  );
  try {
    path.make_directory_with_parents(null);
  } catch (e) {
    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
      return null;
    }
  }

  return path;
};

var SHOT_STORE = _getShotStore(
  GLib.get_user_cache_dir(),
  'extension',
  SCHEMA_NAME
);

