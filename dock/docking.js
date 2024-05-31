/* docking.js
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

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Params = imports.misc.params;

const Main = imports.ui.main;
const Layout = imports.ui.layout;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.dock.utils;
const Theming = Me.imports.dock.theming;
const DockDash = Me.imports.dock.dash;
const { UIImageRenderer } = Me.imports.renderer;
const lg = Utils.lg;

const DOCK_DWELL_CHECK_INTERVAL = 100;

var State = {
  HIDDEN: 0,
  SHOWING: 1,
  SHOWN: 2,
  HIDING: 3
};

const ANIMATION_TIME = 0.2;
const HIDE_DELAY = 0.2;
const HEIGHT_FRACTION = 0.9;
const EDGE_THICKNESS = 8;

var DashSlideContainer = GObject.registerClass(
  {
    Properties: {
      'slide-x': GObject.ParamSpec.double(
        'slide-x',
        'slide-x',
        'slide-x',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        0,
        1,
        1
      ),
      swipe: GObject.ParamSpec.enum(
        'swipe',
        'swipe',
        'swipe',
        GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
        St.Side,
        St.Side.RIGHT
      )
    }
  },
  class DashSlideContainer extends St.Bin {
    _init(params = {}) {
      super._init(params);

      this.connect('notify::slide-x', () => {
        lg('[DashSlideContainer::_init::notify::slide-x]', this.slideX);
        this.queue_relayout();
      });
    }

    vfunc_allocate(box) {
      let contentBox = this.get_theme_node().get_content_box(box);

      box.x1 += -EDGE_THICKNESS;

      this.set_allocation(box);

      if (this.child == null) return;

      let availWidth = contentBox.x2 - contentBox.x1;
      let availHeight = contentBox.y2 - contentBox.y1;
      let [, , natChildWidth, natChildHeight] = this.child.get_preferred_size();

      let childWidth = natChildWidth;
      let childHeight = natChildHeight;

      let childBox = new Clutter.ActorBox();

      if (this.swipe === St.Side.LEFT) {
        childBox.x1 = childWidth * (this.slideX - 1) + EDGE_THICKNESS;
        childBox.x2 = childWidth * this.slideX - EDGE_THICKNESS;
      } else {
        childBox.x1 = 0;
        childBox.x2 = childWidth;
      }
      childBox.y1 = 0;
      childBox.y2 = childBox.y1 + childHeight;

      this.child.allocate(childBox);

      if (this.swipe === St.Side.LEFT) {
        this.child.set_clip(
          -childBox.x1 + EDGE_THICKNESS,
          -childBox.y1,
          -childBox.x1 + availWidth + EDGE_THICKNESS,
          -childBox.y1 + availHeight
        );
      } else {
        this.child.set_clip(
          -childBox.x1,
          -childBox.y1,
          -childBox.x1 + availWidth,
          -childBox.y1 + availHeight
        );
      }
    }

    vfunc_get_preferred_width(forHeight) {
      let [minWidth, natWidth] = super.vfunc_get_preferred_width(
        forHeight || 0
      );
      minWidth = minWidth * this.slideX;
      natWidth = natWidth * this.slideX;
      return [minWidth, natWidth];
    }
  }
);

var DockedDash = GObject.registerClass(
  {
    Properties: {
      docker: GObject.ParamSpec.object(
        'docker',
        'docker',
        'docker',
        GObject.ParamFlags.READWRITE | GObject.ParamSpec.CONSTRUCT,
        UIImageRenderer.$gtype
      )
    },
    Signals: {
      showing: {},
      hiding: {}
    }
  },
  class DashToDock extends St.Bin {
    _init(params) {
      this._alignment = Utils.getAlignment();

      super._init({
        ...params,
        name: 'dockContainer',
        reactive: true,
        style_class: 'right',
        y_expand: false
      });
      this._rtl =
        Clutter.get_default_text_direction() == Clutter.TextDirection.RTL;

      this._ready = false;

      // initialize dock state
      this._dockState = State.HIDDEN;
      // Create a new dash object
      this.dash = new DockDash.DockDash(this);
      this.dash.connect('notify::mapped', () => this.dash._queueRedisplay());

      // Create the containers for sliding in and out and
      // centering, turn on track hover
      this._slider = new DashSlideContainer({
        name: 'DashSlideContainer',
        reactive: true,
        slide_x: 0,
        swipe: St.Side.LEFT,
        y_align: Utils.getAlignment(),
        x_expand: false
      });

      this._box = new St.BoxLayout({
        name: 'dashtodockBox',
        reactive: true,
        track_hover: true
      });
      this._box.connect('notify::hover', this._hoverChanged.bind(this));

      // Connect global signals
      this._signalsHandler = new Utils.GlobalSignalsHandler(this);
      this._signalsHandler.add([
        this.dash,
        'notify::requires-visibility',
        () => this._updateDashVisibility()
      ]);

      this._themeManager = new Theming.ThemeManager(this);

      // Since the actor is not a topLevel child and its parent is now not added to the Chrome,
      // the allocation change of the parent container (slide in and slideout) doesn't trigger
      // anymore an update of the input regions. Force the update manually.
      this.connect(
        'notify::allocation',
        Main.layoutManager._queueUpdateRegions.bind(Main.layoutManager)
      );

      this._signalsHandler.addWithLabel(
        'initialize',
        global.stage,
        'after-paint',
        () => this._initialize()
      );

      this.set_child(this._slider);
      this._slider.set_child(this._box);
      this._box.add_actor(this.dash);

      this._slider.connect('enter-event', () => {
        lg(
          '[DashToDock::mount::_slider::enter-event] isHidden:',
          this.visible,
          this._dockState
        );
        if (this._dockState == State.HIDDEN) {
          this._show();
        }
      });

      // Create and apply height/width constraint to the dash.
      this.connect('notify::height', () => {
        this.dash.setMaxSize(this.width, this.height);
      });
      this._resetPosition();

      this.connect('notify::width', () => (this.translation_x = -this.width));

      this.connect('destroy', this._onDestroy.bind(this));
    }

    _disableApps(appsId) {
      this.dash._disableApps(appsId);
    }

    _enableApps(appsId) {
      this.dash._enableApps(appsId);
    }

    get position() {
      return this._position;
    }

    _initialize() {
      lg('[DashToDock::_initialize] initializing dashtodock...');
      this._signalsHandler.removeWithLabel('initialize');

      this._themeManager.updateCustomTheme();

      this._updateVisibilityMode();
    }

    _enableApps() {
      this.dash._enableApps();
    }

    _disableApps() {
      this.dash._disableApps();
    }

    _onDestroy() {
      this._themeManager.destroy();
    }

    /**
     * This is call when visibility settings change
     */
    _updateVisibilityMode() {
      this.add_style_class_name('autohide');

      this._updateDashVisibility();
    }

    _updateDashVisibility() {
      this._animateIn(ANIMATION_TIME, 0);
    }

    _hoverChanged() {
      lg('[DashToDock::_hoverChanged] hovering...');
      if (this._box.hover) this._show();
      else this._hide();
    }

    getDockState() {
      return this._dockState;
    }

    isHidden() {
      return this._dockState == State.HIDDEN;
    }

    _show() {
      this._delayedHide = false;
      if (this._dockState == State.HIDDEN || this._dockState == State.HIDING) {
        if (this._dockState == State.HIDING)
          // suppress all potential queued transitions - i.e. added but not started,
          // always give priority to show
          this._removeAnimations();

        this.emit('showing');
        this._animateIn(ANIMATION_TIME, 0);
      }
    }

    _hide() {
      // If no hiding animation is running or queued
      if (this._dockState == State.SHOWN || this._dockState == State.SHOWING) {
        let delay = HIDE_DELAY;

        if (this._dockState == State.SHOWING) {
          // if a show already started, let it finish; queue hide without removing the show.
          // to obtain this, we wait for the animateIn animation to be completed
          this._delayedHide = true;
          return;
        }

        this.emit('hiding');
        this._animateOut(ANIMATION_TIME, delay);
      }
    }

    _animateIn(time, delay) {
      this._dockState = State.SHOWING;
      this._delayedHide = false;
      this.dash.playAnimation();

      this._slider.ease_property('slide-x', 1, {
        duration: time * 1000,
        delay: delay * 1000,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._dockState = State.SHOWN;

          if (this._delayedHide) {
            this._hide();
          }
        }
      });
    }

    _animateOut(time, delay) {
      this._dockState = State.HIDING;

      this._slider.ease_property('slide-x', 0, {
        duration: time * 1000,
        delay: delay * 1000,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          this._dockState = State.HIDDEN;
          this.dash.pauseAnimation();
        }
      });
    }

    _resetPosition() {
      if (!this._ready) {
        this._updateVisibilityMode();
      }

      this.remove_style_class_name('fixed');
      this.dash._container.set_height(-1);

      this._ready = true;
    }

    _removeAnimations() {
      this._slider.remove_all_transitions();
    }

    vfunc_motion_event(event) {
      lg('[DashToDock::vfunc_motion_event]');
      return Clutter.EVENT_STOP;
    }
  }
);
