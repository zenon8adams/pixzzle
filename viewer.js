const {Clutter, Cogl, Gio, GObject, GLib, Graphene, Meta, Shell, St} =
    imports.gi;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const {inflateSettings, lg, SCREENSHOT_KEY} = Me.imports.utils;

const INITIAL_WIDTH = 400;
const INITIAL_HEIGHT = 600;
const ALLOWANCE = 80;
var UiMainViewer = GObject.registerClass({
  Signals : {'drag-started' : {}, 'drag-ended' : {}},
},
                                         class UiMainViewer extends St.Widget {
  _init(params) {
    lg('[UiMainViewer::_init]');

    super._init({
      name : 'UiMainViewer',
      layout_manager : new Clutter.BinLayout(),
      opacity : 0,
      visible : false,
      reactive : true,
    });

    this._dragButton = 0;
    this._dragSequence = null;

    this._startX = -1;
    this._startY = 0;
    this._lastX = 0;
    this._lastY = 0;

    this.reset();

    this._isActive = false;
    Main.layoutManager.addTopChrome(this);

    this._closeButton = new St.Button({
      style_class : 'pixzzle-ui-close-button',
      child : new St.Icon({icon_name : 'preview-close-symbolic'}),
      x : 0,
      y : 0
    });
    this._closeButton.add_constraint(new Clutter.AlignConstraint({
      source : this,
      align_axis : Clutter.AlignAxis.X_AXIS,
      pivot_point : new Graphene.Point({x : 1, y : 0}),
      factor : 1,
    }));
    this._closeButton.add_constraint(new Clutter.AlignConstraint({
      source : this,
      align_axis : Clutter.AlignAxis.Y_AXIS,
      pivot_point : new Graphene.Point({x : 0, y : 0}),
      factor : 0
    }));
    this._closeButton.connect('clicked', () => this._close());
    this.add_child(this._closeButton);

    this._baseAdapter = new UIBaseContainerAdapter();
    this._baseAdapter.add_constraint(new Clutter.AlignConstraint(
        {source : this, align_axis : Clutter.AlignAxis.BOTH}));
    this.add_child(this._baseAdapter);
    this._baseContainer = this._baseAdapter.get_base();
    this._label = new St.Label({
      text : 'Hello There',
      x_align : Clutter.ActorAlign.CENTER,
      y_align : Clutter.ActorAlign.CENTER
    });

    this._baseContainer.add_child(this._label);

    this._settings = inflateSettings();

    const uiModes = Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN;
    Main.wm.removeKeybinding(SCREENSHOT_KEY);
    Main.wm.addKeybinding(SCREENSHOT_KEY, this._settings,
                          Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, uiModes,
                          this._showUI.bind(this));

    this._closeButton.connect('style-changed', widget => {
      const padding = widget.width;
      lg('[UiMainViewer::_closeButton::style-changed]', 'padding:', padding);
      this._baseAdapter.set_stage_size(0, 0, this.width - padding * 2,
                                       this.height - padding * 2);
    });
    this.connect('destroy', this._onDestroy.bind(this));
    this._reload_theme();
  }

  _reload_theme() {
    const theme_context = St.ThemeContext.get_for_stage(global.stage);
    const theme = theme_context.get_theme();
    if (!theme)
      return;

    let stylesheet = Me.dir.get_child("stylesheet.css");

    theme.unload_stylesheet(stylesheet);
    theme.load_stylesheet(stylesheet);
    theme_context.set_theme(theme);
  }

  _close() {
    this.remove_all_transitions();
    global.display.set_cursor(Meta.Cursor.DEFAULT);
    this._stopDrag();
    this._isActive = false;
    this.ease({
      opacity : 0,
      duration : 200,
      mode : Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete : () => this.hide(),
    });
  }

  _onDestroy() {}

  _showUI() {
    if (this._isActive)
      return;

    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
      this.opacity = 0;
      this.show();
      this.ease({
        opacity : 255,
        duration : 150,
        mode : Clutter.AnimationMode.EASE_OUT_QUAD,
      });

      lg('[UiMainViewer::_showUI]');

      this._timeoutId = null;
      this._isActive = true;
      return GLib.SOURCE_REMOVE;
    });
    GLib.Source.set_name_by_id(this._timeoutId,
                               '[gnome-shell] UiMainViewe.open');
  }

  reset() {
    this._stopDrag();
    global.display.set_cursor(Meta.Cursor.DEFAULT);

    // Preserve area selection if possible. If the area goes out of bounds,
    // the monitors might have changed, so reset the area.
    const [x, y, w, h] = this._getGeometry();
    // Initially x < 0 will be true so that we can get
    // set the `_activeMonitor` property.
    if (x < 0 || y < 0 || x + w > this?._activeMonitor?.width ||
        y + h > this?._activeMonitor?.height) {
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

        /*\
         * Set the initial dimension of the selection rect
        \*/
        this._startX = monitor.x + monitor.width - INITIAL_WIDTH - ALLOWANCE;
        this._startY = monitor.y + (monitor.height - INITIAL_HEIGHT) / 2;
        this._lastX = this._startX + INITIAL_WIDTH;
        this._lastY = this._startY + INITIAL_HEIGHT;

        this._activeMonitor = monitor;
      }

      this._updateSize();
    }
  }

  _getGeometry() {
    const leftX = Math.min(this._startX, this._lastX);
    const topY = Math.min(this._startY, this._lastY);
    const rightX = Math.max(this._startX, this._lastX);
    const bottomY = Math.max(this._startY, this._lastY);

    return [ leftX, topY, rightX - leftX + 1, bottomY - topY + 1 ];
  }

  _updateSize() {
    const [x, y, w, h] = this._getGeometry();
    this._setRect(x, y, w, h);

    const padding = this?._closeButton?.width;
    this?._baseAdapter?.set_stage_size(0, 0, this.width - padding * 2,
                                       this.height - padding * 2);
  }

  _setRect(x, y, w, h) {
    this.set_position(x, y);
    this.set_size(w, h);
  }

  _computeCursorType(cursorX, cursorY) {
    const desc = '[UiMainViewer::_computeCursorType]';
    const [leftX, topY, width, height] = this._getGeometry();
    const [rightX, bottomY] = [ leftX + width - 1, topY + height - 1 ];
    const [x, y] = [ cursorX, cursorY ];

    const node = this.get_theme_node();
    const threshold =
        10 * St.ThemeContext.get_for_stage(global.stage).scaleFactor;

    const iconSize = this._closeButton.width;

    if ((x - rightX) ** 2 + (y - topY) ** 2 <= iconSize ** 2) {
      return Meta.Cursor.DEFAULT;
    }

    if (x - leftX >= 0 && x - leftX <= threshold) {
      if (y - topY >= 0 && y - topY <= threshold) {
        lg(desc, 'NORTH_WEST');
        return Meta.Cursor.NW_RESIZE;
      } else if (bottomY - y >= 0 && bottomY - y <= threshold) {
        lg(desc, 'SOUTH_WEST');
        return Meta.Cursor.SW_RESIZE;
      } else if (y - topY > 0 && bottomY - y > 0) {
        lg(desc, 'WEST');
        return Meta.Cursor.WEST_RESIZE;
      }
    } else if (y - topY >= 0 && y - topY <= threshold) {
      if (rightX - x >= 0 && rightX - x <= threshold) {
        lg(desc, 'NORTH_EAST');
        return Meta.Cursor.NE_RESIZE;

      } else if (x - leftX > 0 && rightX - x > 0) {
        lg(desc, 'NORTH');
        return Meta.Cursor.NORTH_RESIZE;
      }
    } else if (rightX - x >= 0 && rightX - x <= threshold) {
      if (bottomY - y >= 0 && bottomY - y <= threshold) {
        lg(desc, 'SOUTH_EAST');
        return Meta.Cursor.SE_RESIZE;
      } else if (y - topY > 0 && bottomY - y > 0) {
        lg(desc, 'EAST');
        return Meta.Cursor.EAST_RESIZE;
      }
    } else if (bottomY - y >= 0 && bottomY - y <= threshold) {
      if (x - leftX > 0 && rightX - x > 0) {
        lg(desc, 'SOUTH');
        return Meta.Cursor.SOUTH_RESIZE;
      }
    } else if (x - leftX > 0 && rightX - x > 0) {
      if (y - topY > 0 && bottomY - y > 0) {
        if (x - leftX < iconSize || rightX - x < iconSize ||
            y - topY < iconSize || bottomY - y < iconSize) {
          lg(desc, 'MOVE_OR_RESIZE');
          return Meta.Cursor.MOVE_OR_RESIZE_WINDOW;
        }
      }
    }

    return Meta.Cursor.DEFAULT;
  }

  _stopDrag() {
    if (!this._dragButton)
      return;

    this._dragButton = 0;
    this._dragGrab?.dismiss();
    this._dragGrab = null;
    this._dragSequence = null;

    this.emit('drag-ended');
  }

  _updateCursor(x, y) {
    const cursor = this._computeCursorType(x, y);
    global.display.set_cursor(cursor);
  }

  _onPress(event, button, sequence) {
    if (this._dragButton) {
      return Clutter.EVENT_PROPAGATE;
    }

    this._dragButton = button;
    this._dragGrab = global.stage.grab(this);
    this._dragCursor = this._computeCursorType(event.x, event.y);
    [this._dragX, this._dragY] = [ event.x, event.y ];
    this.emit('drag-started');

    return Clutter.EVENT_STOP;
  }

  _onRelease(event, button, sequence) {
    if ((this._dragButton !== button ||
         this._dragSequence?.get_slot() !== sequence?.get_slot()))
      return Clutter.EVENT_PROPAGATE;

    lg('[UiMainViewer::_onRelease]');
    this._stopDrag();

    const [x, y] = [ event.x, event.y ];
    this._updateCursor(x, y);

    return Clutter.EVENT_STOP;
  }

  _onMotion(event, sequence) {
    lg('[UiMainViewer::_onMotion]');
    const [x, y] = [ event.x, event.y ];
    if (!this._dragButton) {
      this._updateCursor(x, y);
      return Clutter.EVENT_PROPAGATE;
    }

    let dx = Math.round(x - this._dragX);
    let dy = Math.round(y - this._dragY);
    let overshootX, overshootY;
    const cursor =
        this._dragCursor; // this._computeCursorType(event.x, event.y);
    const [monitorWidth, monitorHeight] =
        [ this._activeMonitor.width, this._activeMonitor.height ];

    if (cursor === Meta.Cursor.MOVE_OR_RESIZE_WINDOW) {
      this._startX += dx;
      this._startY += dy;
      this._lastX += dx;
      this._lastY += dy;
    } else {

      if (cursor === Meta.Cursor.NORTH_RESIZE ||
          cursor === Meta.Cursor.SOUTH_RESIZE)
        dx = 0;
      if (cursor === Meta.Cursor.WEST_RESIZE ||
          cursor === Meta.Cursor.EAST_RESIZE)
        dy = 0;

      if (cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.SW_RESIZE ||
          cursor === Meta.Cursor.WEST_RESIZE) {
        this._startX += dx;
      }

      if (cursor === Meta.Cursor.NW_RESIZE ||
          cursor === Meta.Cursor.NE_RESIZE ||
          cursor === Meta.Cursor.NORTH_RESIZE) {
        this._startY += dy;
      }

      if (cursor === Meta.Cursor.SE_RESIZE ||
          cursor === Meta.Cursor.NE_RESIZE ||
          cursor === Meta.Cursor.EAST_RESIZE) {
        this._lastX += dx;
      }

      if (cursor === Meta.Cursor.SW_RESIZE ||
          cursor === Meta.Cursor.SE_RESIZE ||
          cursor === Meta.Cursor.SOUTH_RESIZE) {
        this._lastY += dy;
      }
    }

    if (this._startX < 0) {
      overshootX = -this._startX;
      this._startX += overshootX;
      this._lastX += overshootX;
      dx -= overshootX;
    } else if (this._lastX >= monitorWidth) {
      overshootX = monitorWidth - this._lastX;
      this._startX += overshootX;
      this._lastX += overshootX;
      dx -= overshootX;
    }

    if (this._startY < 0) {
      overshootY = -this._startY;
      this._startY += overshootY;
      this._lastY += overshootY;
      dy -= overshootY;
    } else if (this._lastY >= monitorHeight) {
      overshootY = monitorHeight - this._lastY;
      this._startY += overshootY;
      this._lastY += overshootY;
      dy -= overshootY;
    }

    this._updateSize();

    this._dragX += dx;
    this._dragY += dy;
    return Clutter.EVENT_STOP;
  }

  vfunc_button_press_event(event) {
    const button = event.button;
    if (button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY)
      return this._onPress(event, button, null);

    return Clutter.EVENT_PROPAGATE;
  }

  vfunc_button_release_event(event) {
    const button = event.button;
    if (button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY)
      return this._onRelease(event, button, null);

    return Clutter.EVENT_PROPAGATE;
  }

  vfunc_motion_event(event) { return this._onMotion(event, null); }

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
    lg('[UiMainViewer::vfunc_leave_event]');
    if (this._dragButton) {
      this._onMotion(event, null);
      return Clutter.EVENT_STOP;
    }

    return super.vfunc_leave_event(event);
  }

  vfunc_enter_event(event) {
    lg('[UiMainViewer::vfunc_enter_event]');
    return super.vfunc_enter_event(event);
  }
});

const UIBaseContainerAdapter =
    GObject.registerClass(class UIBaseContainer extends St.Widget {
      _init(params) {
        super._init(params);

        this._baseContainer =
            new St.Widget({style_class : 'pixzzle-ui-base-container'});
        this.add_child(this._baseContainer);
      }

      set_stage_size(x, y, width, height) {
        this._baseContainer.set_position(x, y);
        this._baseContainer.set_size(width, height);
        lg('[UIBaseContainerAdapter::set_stage_size]', x, y, width, height);
      }

      get_base() { return this._baseContainer; }
    });
