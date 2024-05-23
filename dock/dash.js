/* dash.js
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
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const AppDisplay = Me.imports.dock.appDisplay;
const UIApp = Me.imports.dock.apps;
//const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const Util = imports.misc.util;
const Workspace = imports.ui.workspace;

const Docking = Me.imports.dock.docking;
const Utils = Me.imports.dock.utils;
const AppIcons = Me.imports.dock.appIcons;
const Dash = Me.imports.dock.dash_base;
const lg = Utils.lg;

const DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME;
const DASH_ITEM_LABEL_HIDE_TIME = Dash.DASH_ITEM_LABEL_HIDE_TIME;
const DASH_ITEM_HOVER_TIMEOUT = Dash.DASH_ITEM_HOVER_TIMEOUT;
const DASH_VISIBILITY_TIMEOUT = 3;
const DASH_MAX_ICON_SIZE = 36;

var DockDashItemContainer = GObject.registerClass(
  class DockDashItemContainer extends Dash.DashItemContainer {
    _init(app) {
      super._init();
      this.app = app;
    }
    showLabel() {
      return AppIcons.itemShowLabel.call(this);
    }
  }
);

const DockDashIconsVerticalLayout = GObject.registerClass(
  class DockDashIconsVerticalLayout extends Clutter.BoxLayout {
    _init() {
      super._init({
        orientation: Clutter.Orientation.VERTICAL
      });
    }

    vfunc_get_preferred_height(container, forWidth) {
      const [natHeight] = super.vfunc_get_preferred_height(container, forWidth);
      return [natHeight, 0];
    }
  }
);

const baseIconSizes = [16, 22, 24, 32, 48, 64, 96, 128];

var DockDash = GObject.registerClass(
  {
    Signals: {
      'icon-size-changed': {}
    }
  },
  class DockDash extends St.Widget {
    _init(controller) {
      // Initialize icon variables and size
      this._maxWidth = -1;
      this._maxHeight = -1;
      this.iconSize = DASH_MAX_ICON_SIZE;
      this._shownInitially = false;
      this._initializeIconSize(this.iconSize);

      this._position = Utils.getPosition();
      this._isHorizontal =
        this._position == St.Side.TOP || this._position == St.Side.BOTTOM;
      this._alignment = Utils.getAlignment();

      this._controller = controller;
      this._docker = controller.docker;
      this._dragPlaceholder = null;
      this._dragPlaceholderPos = -1;
      this._animatingPlaceholdersCount = 0;
      this._showLabelTimeoutId = 0;
      this._resetHoverTimeoutId = 0;
      this._labelShowing = false;

      super._init({
        name: 'dash',
        offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
        layout_manager: new Clutter.BinLayout()
      });
      this._dashContainer = new St.BoxLayout({
        name: 'dashtodockDashContainer',
        x_align: this._alignment,
        y_align: this._alignment,
        vertical: !this._isHorizontal,
        y_expand: this._isHorizontal,
        x_expand: !this._isHorizontal
      });

      this._scrollView = new St.ScrollView({
        name: 'dashtodockDashScrollview',
        hscrollbar_policy: this._isHorizontal
          ? St.PolicyType.EXTERNAL
          : St.PolicyType.NEVER,
        vscrollbar_policy: this._isHorizontal
          ? St.PolicyType.NEVER
          : St.PolicyType.EXTERNAL,
        x_expand: this._isHorizontal,
        y_expand: !this._isHorizontal,
        enable_mouse_scrolling: false
      });

      this._scrollView.connect('scroll-event', this._onScrollEvent.bind(this));

      let rtl =
        Clutter.get_default_text_direction() == Clutter.TextDirection.RTL;
      this._box = new St.BoxLayout({
        name: 'dashtodockScrollBox',
        vertical: !this._isHorizontal,
        clip_to_allocation: false,
        ...(!this._isHorizontal
          ? { layout_manager: new DockDashIconsVerticalLayout() }
          : {}),
        x_align: rtl ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        y_align: this._isHorizontal
          ? this._alignment
          : Clutter.ActorAlign.START,
        y_expand: !this._isHorizontal,
        x_expand: this._isHorizontal
      });
      this._box._delegate = this;
      this._dashContainer.add_actor(this._scrollView);
      this._scrollView.add_actor(this._box);
      this._background = new St.Widget({
        style_class: 'dash-background',
        y_expand: this._isHorizontal,
        x_expand: !this._isHorizontal
      });

      const sizerBox = new Clutter.Actor();
      sizerBox.add_constraint(
        new Clutter.BindConstraint({
          source: this._dashContainer,
          coordinate: Clutter.BindCoordinate.HEIGHT
        })
      );
      sizerBox.add_constraint(
        new Clutter.BindConstraint({
          source: this._dashContainer,
          coordinate: Clutter.BindCoordinate.WIDTH
        })
      );
      this._background.add_child(sizerBox);

      this.add_child(this._background);
      this.add_child(this._dashContainer);

      this.connect('destroy', this._onDestroy.bind(this));
    }

    playAnimation() {
      this._box
        .get_children()
        .forEach(
          (child) =>
            child.app.get_id() &&
            child.app.animatable() &&
            child.app.icon.play()
        );
    }

    pauseAnimation() {
      this._box
        .get_children()
        .forEach(
          (child) =>
            child.app.get_id() &&
            child.app.animatable() &&
            child.app.icon.stop()
        );
    }

    _hide() {
        this._controller._hide();
    }

    vfunc_get_preferred_height(forWidth) {
      let [minHeight, natHeight] = super.vfunc_get_preferred_height.call(
        this,
        forWidth
      );
      if (
        !this._isHorizontal &&
        this._maxHeight !== -1 &&
        natHeight > this._maxHeight
      )
        return [minHeight, this._maxHeight];
      else return [minHeight, natHeight];
    }

    vfunc_get_preferred_width(forHeight) {
      let [minWidth, natWidth] = super.vfunc_get_preferred_width.call(
        this,
        forHeight
      );
      if (
        this._isHorizontal &&
        this._maxWidth !== -1 &&
        natWidth > this._maxWidth
      )
        return [minWidth, this._maxWidth];
      else return [minWidth, natWidth];
    }

    get _container() {
      return this._dashContainer;
    }

    _onDestroy() {
      if (this._requiresVisibilityTimeout)
        GLib.source_remove(this._requiresVisibilityTimeout);
      this.pauseAnimation();
    }

    _hookUpLabel() {
      return Dash.Dash.prototype._hookUpLabel.call(this, ...arguments);
    }

    _syncLabel() {
      return Dash.Dash.prototype._syncLabel.call(this, ...arguments);
    }

    _onScrollEvent(actor, event) {
      // reset timeout to avid conflicts with the mousehover event
      this._ensureItemVisibility(null);

      // Skip to avoid double events mouse
      // TODO: Horizontal events are emulated, potentially due to a conflict
      // with the workspace switching gesture.
      if (!this._isHorizontal && event.is_pointer_emulated()) {
        return Clutter.EVENT_STOP;
      }

      let adjustment,
        delta = 0;

      if (this._isHorizontal)
        adjustment = this._scrollView.get_hscroll_bar().get_adjustment();
      else adjustment = this._scrollView.get_vscroll_bar().get_adjustment();

      let increment = adjustment.step_increment;

      if (this._isHorizontal) {
        switch (event.get_scroll_direction()) {
          case Clutter.ScrollDirection.LEFT:
            delta = -increment;
            break;
          case Clutter.ScrollDirection.RIGHT:
            delta = +increment;
            break;
          case Clutter.ScrollDirection.SMOOTH: {
            let [dx, dy] = event.get_scroll_delta();
            // TODO: Handle y
            //delta = dy * increment;
            // Also consider horizontal component, for instance touchpad
            delta = dx * increment;
            break;
          }
        }
      } else {
        switch (event.get_scroll_direction()) {
          case Clutter.ScrollDirection.UP:
            delta = -increment;
            break;
          case Clutter.ScrollDirection.DOWN:
            delta = +increment;
            break;
          case Clutter.ScrollDirection.SMOOTH: {
            let [, dy] = event.get_scroll_delta();
            delta = dy * increment;
            break;
          }
        }
      }

      const value = adjustment.get_value();

      // TODO: Remove this if possible.
      if (Number.isNaN(value)) {
        adjustment.set_value(delta);
      } else {
        adjustment.set_value(value + delta);
      }

      return Clutter.EVENT_STOP;
    }

    _ensureItemVisibility(actor) {
      if (actor?.hover) {
        const destroyId = actor.connect('destroy', () =>
          this._ensureItemVisibility(null)
        );
        this._ensureActorVisibilityTimeoutId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          100,
          () => {
            actor.disconnect(destroyId);
            ensureActorVisibleInScrollView(this._scrollView, actor);
            this._ensureActorVisibilityTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }
        );
      } else if (this._ensureActorVisibilityTimeoutId) {
        GLib.source_remove(this._ensureActorVisibilityTimeoutId);
        this._ensureActorVisibilityTimeoutId = 0;
      }
    }

    _createAppItem(app) {
      const appIcon = new AppIcons.makeAppIcon(app);

      const item = new DockDashItemContainer(app);
      item.setChild(appIcon);

      appIcon.connect('notify::hover', (a) => this._ensureItemVisibility(a));

      appIcon.label_actor = null;
      item.setLabelText(app.get_name());

      appIcon.icon.setIconSize(this.iconSize);
      this._hookUpLabel(item, appIcon);

      return item;
    }

    _requireVisibility() {
      this.requiresVisibility = true;

      if (this._requiresVisibilityTimeout)
        GLib.source_remove(this._requiresVisibilityTimeout);

      this._requiresVisibilityTimeout = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        DASH_VISIBILITY_TIMEOUT,
        () => {
          this._requiresVisibilityTimeout = 0;
          this.requiresVisibility = false;
        }
      );
    }

    _queueRedisplay() {
      this._workId = Main.initializeDeferredWork(
        this._box,
        this._redisplay.bind(this)
      );
    }

    _redisplay() {
      const current = this._box
        .get_children()
        .map((child) => child.app.get_id());
      lg('[DockDash::_redisplay] current:', current);
      const apps = UIApp.getApps().filter(
        (app) => !current.includes(app.get_id())
      );
      apps.forEach((app) => {
        lg('[DockDash::_redisplay] app:', app);
        app.connect('clicked', (_, ev) => {
          this._docker._onKeyPress(ev);
          app.hide_on_trigger() && this._hide();
        });
        const item = this._createAppItem(app);
        this._box.add_child(item);
        item.show(true);
      });

      this._adjustIconSize();
    }

    _adjustIconSize() {
      let iconChildren = this._box.get_children().filter((actor) => {
        lg('[DockDash::_adjustIconSize] actor:', actor);
        return actor.child && actor.child.icon;
      });

      if (this._maxWidth === -1 || this._maxHeight === -1) return;

      const themeNode = this.get_theme_node();
      const maxAllocation = new Clutter.ActorBox({
        x1: 0,
        y1: 0,
        x2: this._maxWidth,
        y2: this._maxHeight
      });
      let maxContent = themeNode.get_content_box(maxAllocation);
      let availWidth = maxContent.x2 - maxContent.x1;
      let spacing = themeNode.get_length('spacing');

      let firstButton = iconChildren[0].child;
      let firstIcon = firstButton.icon;

      // Enforce valid spacings during the size request
      firstIcon.icon.ensure_style();
      const [, , iconWidth, iconHeight] = firstIcon.icon.get_preferred_size();
      const [, , buttonWidth, buttonHeight] = firstButton.get_preferred_size();

      // Subtract icon padding and box spacing from the available width
      availWidth -=
        iconChildren.length * (buttonWidth - iconWidth) +
        (iconChildren.length - 1) * spacing;

      let availHeight = this._maxHeight;
      availHeight -= this.margin_top + this.margin_bottom;
      availHeight -= this._background.get_theme_node().get_vertical_padding();
      availHeight -= themeNode.get_vertical_padding();
      availHeight -= buttonHeight - iconHeight;

      let scaleFactor = St.ThemeContext.get_for_stage(
        global.stage
      ).scale_factor;
      let iconSizes = baseIconSizes.map((s) => s * scaleFactor);

      let newIconSize = baseIconSizes[0];
      for (let i = 0; i < iconSizes.length; i++) {
        if (iconSizes[i] > DASH_MAX_ICON_SIZE) {
          newIconSize = baseIconSizes[i > 0 ? i - 1 : i];
          break;
        }
      }

      if (newIconSize === this.iconSize) return;

      let oldIconSize = this.iconSize;
      this.iconSize = newIconSize;
      this.emit('icon-size-changed');

      let scale = oldIconSize / newIconSize;
      for (let i = 0; i < iconChildren.length; i++) {
        let icon = iconChildren[i].child.icon;

        icon.setIconSize(this.iconSize);

        let [targetWidth, targetHeight] = icon.icon.get_size();

        icon.icon.set_size(icon.icon.width * scale, icon.icon.height * scale);

        icon.icon.ease({
          width: targetWidth,
          height: targetHeight,
          duration: DASH_ANIMATION_TIME,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
      }
    }

    _initializeIconSize(max_size) {
      let max_allowed = baseIconSizes[baseIconSizes.length - 1];
      max_size = Math.min(max_size, max_allowed);

      this._availableIconSizes = [max_size];
    }

    setIconSize(max_size, doNotAnimate) {
      this._initializeIconSize(max_size);

      if (doNotAnimate) this._shownInitially = false;
    }

    resetAppIcons() {
      let children = this._box.get_children().filter(function (actor) {
        return actor.child && !!actor.child.icon;
      });
      for (let i = 0; i < children.length; i++) {
        let item = children[i];
        item.destroy();
      }

      // to avoid ugly animations, just suppress them like when dash is first loaded.
      this._shownInitially = false;
      this._redisplay();
    }

    setMaxSize(maxWidth, maxHeight) {
      if (this._maxWidth === maxWidth && this._maxHeight === maxHeight) return;

      this._maxWidth = maxWidth;
      this._maxHeight = maxHeight;

      this._queueRedisplay();
    }

    vfunc_enter_event(event) {
      return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
      return Clutter.EVENT_STOP;
    }
  }
);

function ensureActorVisibleInScrollView(scrollView, actor) {
  const { adjustment: vAdjustment } = scrollView.vscroll;
  const { adjustment: hAdjustment } = scrollView.hscroll;
  const { value: vValue0, pageSize: vPageSize, upper: vUpper } = vAdjustment;
  const { value: hValue0, pageSize: hPageSize, upper: hUpper } = hAdjustment;
  let [hValue, vValue] = [hValue0, vValue0];
  let vOffset = 0;
  let hOffset = 0;
  let fade = scrollView.get_effect('fade');
  if (fade) {
    vOffset = fade.fade_margins.top;
    hOffset = fade.fade_margins.left;
  }

  let box = actor.get_allocation_box();
  let y1 = box.y1,
    y2 = box.y2,
    x1 = box.x1,
    x2 = box.x2;

  let parent = actor.get_parent();
  while (parent != scrollView) {
    if (!parent) throw new Error('Actor not in scroll view');

    let box = parent.get_allocation_box();
    y1 += box.y1;
    y2 += box.y1;
    x1 += box.x1;
    x2 += box.x1;
    parent = parent.get_parent();
  }

  if (y1 < vValue + vOffset) vValue = Math.max(0, y1 - vOffset);
  else if (vValue < vUpper - vPageSize && y2 > vValue + vPageSize - vOffset)
    vValue = Math.min(vUpper - vPageSize, y2 + vOffset - vPageSize);

  if (x1 < hValue + hOffset) hValue = Math.max(0, x1 - hOffset);
  else if (hValue < hUpper - hPageSize && x2 > hValue + hPageSize - hOffset)
    hValue = Math.min(hUpper - hPageSize, x2 + hOffset - hPageSize);

  if (vValue !== vValue0) {
    vAdjustment.ease(vValue, {
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      duration: Util.SCROLL_TIME
    });
  }

  if (hValue !== hValue0) {
    hAdjustment.ease(hValue, {
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      duration: Util.SCROLL_TIME
    });
  }

  return [hValue - hValue0, vValue - vValue0];
}
