const { Gio, GLib } = imports.gi;

const Main = imports.ui.main;
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

function computePanelPosition() {
  const invisible = { x: 0, y: 0, width: 0, height: 0 };
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
    Top: isTop ? panel : invisible,
    Right: isRight ? panel : invisible,
    Bottom: isBottom ? panel : invisible,
    Left: isLeft ? panel : invisible
  };
}

var Panel = computePanelPosition();
