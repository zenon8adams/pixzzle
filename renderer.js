/* renderer.js
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

const {
  Clutter,
  Cogl,
  Gio,
  GObject,
  GLib,
  Meta,
  St,
  GdkPixbuf,
  Soup,
  Pango,
  Graphene
} = imports.gi;

const Cairo = imports.cairo;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Prefs = Me.imports.prefs;
const { lg, Constants, inflateSettings, getIconsLocation } = Me.imports.utils;

const { storeScreenshot } = Me.imports.common;

/*
 * Import only what you need as importing Gdk in shell process is
 * not allowed.
 * https://gjs.guide/extensions/review-guidelines/review-guidelines.html
 * #do-not-import-gtk-libraries-in-gnome-shell
 */
const { cairo_set_source_pixbuf } = imports.gi.Gdk;

const OCR_URL = 'http://api.ocr.space/parse/image';

let SETTING_NATURAL_PANNING;
let SETTING_OCR_API;

const ViewOrientation = Object.freeze({ TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3 });
const Directivity = Object.freeze({ NEXT: 1, PREV: -1 });
const N_AXIS = 4;

var UIImageRenderer = GObject.registerClass(
  {
    Signals: {
      'lock-axis': { param_types: [Object.prototype] },
      'clean-slate': {},
      'drag-action': {},
      'ocr-cancelled': {},
      'switch-active': { param_types: [Object.prototype] },
      'new-shot': { param_types: [GObject.TYPE_STRING] }
    }
  },
  class UIImageRenderer extends St.Widget {
    _init(anchor) {
      super._init({
        name: 'UIImageRenderer',
        reactive: true,
        can_focus: true,
        y_expand: true,
        x_expand: true,
        layout_manager: new Clutter.BinLayout()
      });
      this._xpos = 0;
      this._ypos = 0;
      /**
       * leftX, topY, zoomX, zoomY,
       * zoomedWidth, zoomedHeight => Holds panning
       * information during zoom operation.
       */
      this._leftX = 0;
      this._topY = 0;
      this._zoomX = 0;
      this._zoomY = 0;
      this._lastScale = -1;
      this._zoomedWidth = 0;
      this._zoomedHeight = 0;
      this._anchor = anchor;
      // Are we panning on a zoomed image?
      this._dragZoom = false;

      lg('[UIImageRenderer::_init]');
      this._canvas = new Clutter.Canvas();
      this.set_content(this._canvas);
      this._orientationLU = new Array(N_AXIS);
      this._orientation = ViewOrientation.TOP;
      this._snipIndicator = new St.Widget({
        style_class: 'pixzzle-ui-ocr-indicator'
      });
      this.add_child(this._snipIndicator);

      this._ocrText = new UIOcrTip(this._snipIndicator, this, {
        style_class: 'pixzzle-ui-ocrtip',
        x_align: St.Align.START,
        visible: false,
        reactive: true
      });
      this._ocrText.clutter_text.set_editable(false);
      this._ocrText.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      this._anchor.add_child(this._ocrText);

      this._zoomToolBox = new UIZoomTool(this);
      this.add_child(this._zoomToolBox);

      this._loadSettings();

      this._snipActions = {
        [Clutter.KEY_o]: this._doOCR.bind(this),
        [Clutter.KEY_O]: this._doOCR.bind(this),
        [Clutter.KEY_c]: this._doCopyImage.bind(this),
        [Clutter.KEY_C]: this._doCopyImage.bind(this),
        [Clutter.KEY_x]: this._doAddCutout.bind(this),
        [Clutter.KEY_X]: this._doAddCutout.bind(this)
      };
      this._snipTrigger = null;

      this._canvas.connect('draw', this._draw.bind(this));
      this.connect('destroy', this._onDestroy.bind(this));
    }

    _redraw(deltaX, deltaY) {
      if (this._filename) {
        const [width, height] = this._getMaxSize();
        this._render(deltaX, deltaY, width, height);
      } else {
        this._isPanningEnabled = false;
        this._closeSnipToolkit();
      }
    }

    _draw(canvas, context) {
      lg('[UIImageRenderer::_draw] filename:', this._filename);
      if (this._pixbuf && this._filename) {
        const [pixWidth, pixHeight] = this._getBufferArea();
        const [maxWidth, maxHeight] = this._getMaxSize();
        /*
         * Calculate the actual size of the viewport taking
         * into account, the size of the image and the panning
         * actions that have been done previously.
         */
        const [effectiveWidth, effectiveHeight] = [
          Math.min(pixWidth - this._xpos, maxWidth),
          Math.min(pixHeight - this._ypos, maxHeight)
        ];
        lg(
          '[UIImageRenderer::_init::_draw] effectiveWidth:',
          effectiveWidth,
          'effectiveHeight:',
          effectiveHeight,
          'xpos:',
          this._xpos,
          'ypos:',
          this._ypos
        );
        const pixbuf = this._pixbufAfterTransform(
          this._xpos,
          this._ypos,
          effectiveWidth,
          effectiveHeight
        );
        if (pixbuf === null) {
          lg('[UIImageRenderer::_init::_draw]', 'pixbuf = (null)');
          return;
        }
        this._visibleRegionPixbuf = pixbuf;

        context.save();
        context.setOperator(Cairo.Operator.CLEAR);
        context.paint();
        context.restore();
        cairo_set_source_pixbuf(
          context,
          this._visibleRegionPixbuf,
          (maxWidth - pixbuf.get_width()) / 2,
          (maxHeight - pixbuf.get_height()) / 2
        );
        context.paint();

        /*
         * For a new screenshot, this._ocrScanOnEntry
         * flag indicates that we want to perform
         * ocr scan immediately we screenshot the
         * image.
         */
        if (this._ocrScanOnEntry) {
          this._ocrScanOnEntry = false;
          this._openSnipToolkit();
          this._snipIndicator.x = (maxWidth - pixbuf.width) / 2;
          this._snipIndicator.y = (maxHeight - pixbuf.height) / 2;
          this._snipIndicator.width = this._pixbuf.width;
          this._snipIndicator.height = this._pixbuf.height;
          this._doOCR(this._pixbuf);
        }
      } else {
        context.save();
        context.setOperator(Cairo.Operator.CLEAR);
        context.paint();
        this._filename = null;
      }
    }

    _replace(shot) {
      const newFile = shot.name;
      this._shotWidget = shot.widget;
      this._ocrScanOnEntry = shot.ocr;
      lg(
        '[UIImageRenderer::_replace]',
        'newFile:',
        newFile,
        'next shot:',
        this._shotWidget
      );
      if (newFile == null) {
        this._unload();
        this.set_size(0, 0);
        this._reOrient(-this._orientation, true /* flush */);
        this.emit('clean-slate');
        this._isPanningEnabled = false;
        this._origPixbuf = null;
        this._zoomToolBox.resetZoom();
      } else if (newFile !== this._filename) {
        /*
         * Since we support rotation, create
         * a pixel buffer with a size of the
         * maximum dimension that can be achieved
         * through rotation. Any time we want
         * to render, we will rotate the mouse
         * to the current angle.
         */
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(newFile);
        if (pixbuf != null) {
          this.abortSnipSession();
          this._reOrient(-this._orientation, true /* flush */);
          this._pixbuf = pixbuf;
          this._origPixbuf = pixbuf;
          this._filename = newFile;
          this._zoomToolBox.resetZoom();
          this._reload();
        }
      }
    }

    _pixbufAfterTransform(startX, startY, w, h) {
      let pb = null;
      const sf = this._getScale();
      const [vw, vh] = this._getMaxSize();
      const sc = 1 / sf;
      const image = this._origPixbuf;
      const iw = image.get_width();
      const ih = image.get_height();
      if (sf > 1) {
        /**
         * +-------------+
         * |  +-------+  |
         * |  |       |  |
         * |  +-------+  |
         * +-------------+
         *  The outer box is the viewport where we want to
         *  show the image. The inner box is the dimension of
         *  the image that will eventually get zoomed in.
         *  If the size of the loaded image is less than the
         *  view port, we use the size of the image as the
         *  clip region then we scale the image directly.
         */
        const [leftX, topY] = [
          Math.max(0, startX + w * (1 - sc) * 0.5),
          Math.max(0, startY + h * (1 - sc) * 0.5)
        ];
        const [width, height] = [sc * w, sc * h];
        const [scw, sch] = [w, h];
        let [minX, minY] = [
          Math.max(0, leftX + this._zoomX),
          Math.max(0, topY + this._zoomY)
        ];
        if (minX + width > iw) {
          minX = Math.max(0, minX - (minX + width) + iw);
        }
        if (minY + height > ih) {
          minY = Math.max(0, minY - (minY + height) + ih);
        }
        pb = image
          .new_subpixbuf(minX, minY, width, height)
          .scale_simple(scw, sch, GdkPixbuf.InterpType.BILINEAR);
        if (!this._dragZoom) {
          this._leftX = leftX;
          this._topY = topY;
          this._zoomedWidth = width;
          this._zoomedHeight = height;
        }
      } else if (sf < 1) {
        const [leftX, topY] = [
          Math.max(0, startX + w * (1 - sc) * 0.5),
          Math.max(0, startY + h * (1 - sc) * 0.5)
        ];
        const [rightX, bottomY] = [
          Math.min(iw, startX + w * (1 + sc) * 0.5),
          Math.min(ih, startY + h * (1 + sc) * 0.5)
        ];
        const [width, height] = [rightX - leftX, bottomY - topY];
        const [scw, sch] = [width * sf, height * sf];
        let [minX, minY] = [
          Math.max(0, leftX + this._zoomX),
          Math.max(0, topY + this._zoomY)
        ];
        /**
         * Expand if the panning position is set to start,
         * at zoom level 1 and we then zoom out and pan,
         * trying to zoom out will lead to problems requiring
         * the leftmost coordinates to be expanded backwards.
         */
        if (minX + width > iw) {
          minX = Math.max(0, minX - (minX + width) + iw);
        }
        if (minY + height > ih) {
          minY = Math.max(0, minY - (minY + height) + ih);
        }
        pb = image
          .new_subpixbuf(minX, minY, width, height)
          .scale_simple(scw, sch, GdkPixbuf.InterpType.BILINEAR);
        if (!this._dragZoom) {
          this._leftX = leftX;
          this._topY = topY;
          this._zoomedWidth = width;
          this._zoomedHeight = height;
        }
      } else {
        pb = image.new_subpixbuf(startX, startY, w, h);
      }

      return pb;
    }

    _unload() {
      this._pixbuf = null;
      this._canvas.invalidate();
    }

    _reload() {
      if (!this._filename) {
        return;
      }
      const [width, height] = this._getMaxSize();
      const [pixWidth, pixHeight] = this._getBufferArea();
      this.emit('lock-axis', {
        X_AXIS: pixWidth - width,
        Y_AXIS: pixHeight - height
      });
      this._redraw(0, 0);
    }

    _getBufferArea() {
      const width = this._origPixbuf.get_width();
      const height = this._origPixbuf.get_height();
      return [width, height];
    }

    _loadScaled() {
      const sf = this._getScale();
      /**
       * The implementation of zoom here is such that
       * the main window doesn't expand past the original
       * image size and not the expanded image size. You
       * have to pan around the view to be able to view
       * the scaled up image.
       * We use different variables to monitor panning
       * actions. For scale level 1 (no scaling), we use
       * `this._xpos` and `this._ypos`. For other levels,
       * we use `this._zoomX` and `this._zoomY` to keep
       * track of their panning. Here comes the issue,
       * we need a way of synchronizing the panning
       * activity on other zoom levels with scale level 1.
       * We do this by computing the offset added due to
       * scaling. We use the formula:
       * scaleDelta = view-width * (1/s1 - 1/s0) * 1/2
       * where `s0` is the previous scale and `s1` is the
       * current scale (1).
       * This gives us "zoom extent".
       */
      if (sf === 1) {
        const [zoomWidth, zoomHeight] = this._getBufferArea();
        const scaleDiff = this._lastScale - sf;
        const halfWidth = this.width / 2;
        const halfHeight = this.height / 2;
        const scaleProd = sf * this._lastScale;
        const scaleProp = scaleDiff / scaleProd;
        const scaleDeltaX = halfWidth * scaleProp;
        const scaleDeltaY = halfHeight * scaleProp;
        let [minX, minY] = [
          this._leftX + this._zoomX,
          this._topY + this._zoomY
        ];
        // Downscaling...
        if (this._lastScale > sf) {
          if (minX <= scaleDeltaX) {
            minX = 0;
          } else if (minX + this._zoomedWidth + scaleDeltaX > zoomWidth) {
            minX = Math.max(0, this._xpos + this._zoomX - scaleDeltaX);
          } else {
            minX = Math.max(0, this._xpos + this._zoomX);
          }
          if (minY <= scaleDeltaY) {
            minY = 0;
          } else if (minY + this._zoomedHeight + scaleDeltaY > zoomHeight) {
            minY = Math.max(0, this._ypos + this._zoomY - scaleDeltaY);
          } else {
            minY = Math.max(0, this._ypos + this._zoomY);
          }
        } else {
          if (minX <= scaleDeltaX) {
            minX = 0;
          } else if (minX + this._zoomedWidth >= zoomWidth) {
            minX = Math.max(0, this._xpos + this._zoomX);
          } else {
            minX = Math.max(0, this._xpos + this._zoomX);
          }
          if (minY <= scaleDeltaY) {
            minY = 0;
          } else if (minY + this._zoomedHeight >= zoomHeight) {
            minY = Math.max(0, this._ypos + this._zoomY);
          } else {
            minY = Math.max(0, this._ypos + this._zoomY);
          }
        }
        this._xpos = minX;
        this._ypos = minY;
        this._leftX = 0;
        this._topY = 0;
        this._zoomX = 0;
        this._zoomY = 0;
        this._zoomedWidth = 0;
        this._zoomedHeight = 0;
      }
      this._dragZoom = false;
      this._canvas.invalidate();
      this._lastScale = sf;
    }

    _getMaxSize() {
      const [width, height] = this._anchor._computeBigViewSize();
      return [width, height];
    }

    _render(deltaX, deltaY, maxWidth, maxHeight) {
      const [pixWidth, pixHeight] = this._getBufferArea();
      this._isPanningEnabled = pixWidth > maxWidth || pixHeight > maxHeight;
      this._updateToolkits();
      const lockedAxis = {
        X_AXIS: pixWidth <= maxWidth,
        Y_AXIS: pixHeight <= maxHeight
      };
      if (!this._isPanningEnabled) {
        this._xpos = this._ypos = 0;
      } else {
        /*
         * If the panning area is not yet
         * at the edge, move the area
         * to fill up the space created
         * from the drag.
         * Clip the drag delta that is added
         * so that we don't exceed the
         * maximum size of the image.
         */
        if (!lockedAxis.X_AXIS && this._xpos + maxWidth >= pixWidth) {
          this._xpos += Math.max(
            -Math.abs(deltaX),
            pixWidth - this._xpos - maxWidth
          );
        }

        if (!lockedAxis.Y_AXIS && this._ypos + maxHeight >= pixHeight) {
          this._ypos += Math.max(
            -Math.abs(deltaY),
            pixHeight - this._ypos - maxHeight
          );
        }

        /**
         * If we are resizing and we are scaled, we need to update the
         * coordinate of the zoom control points. The flag
         * `this._dragZoom` indicates that we are not in drag or zoom
         * mode (in this context).
         */
        if (this._isScaled()) {
          this._dragZoom = false;
        }
      }

      this._canvas.invalidate();
      this._canvas.set_size(maxWidth, maxHeight);
      this.set_size(maxWidth, maxHeight);
    }

    /*
     * Keep track of panning state at the current
     * orientation and restore on the next rotation.
     */
    _reOrient(by, flush) {
      if (flush) {
        this._orientationLU.fill(null);
      } else {
        this._orientationLU[this._orientation] = {
          x: this._xpos,
          y: this._ypos
        };
      }

      const next = (this._orientation + by) % N_AXIS;
      this._orientation = next;
      const pos = this._orientationLU[next];

      this._xpos = pos?.x ?? 0;
      this._ypos = pos?.y ?? 0;
    }

    _getScale() {
      return this._zoomToolBox.zoomFactor;
    }

    _copyTextToClipboard(text, message) {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

      this._notifyUser(
        message,
        'Text is available in your clipboard',
        'screenshot-recorded-symbolic'
      );
    }

    _copyImageToClipboard(pixbuf, message, onComplete = null) {
      if (pixbuf == null) {
        this._notifyOfEmptyView();
        return;
      }
      if (this._clipboardCopyCancellable) {
        this._clipboardCopyCancellable.cancel();
      }

      this._clipboardCopyCancellable = new Gio.Cancellable();
      const stream = Gio.MemoryOutputStream.new_resizable();
      pixbuf.save_to_streamv_async(
        stream,
        'png',
        [],
        [],
        this._clipboardCopyCancellable,
        (pixbuf, task) => {
          if (!GdkPixbuf.Pixbuf.save_to_stream_finish(task)) {
            return;
          }
          stream.close(null);
          const clipboard = St.Clipboard.get_default();
          const bytes = stream.steal_as_bytes();
          clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
          lg('[UIImageRenderer::_copyToClipboard]');

          onComplete?.(bytes);

          const time = GLib.DateTime.new_now_local();
          const pixels = pixbuf.read_pixel_bytes();
          const content = St.ImageContent.new_with_preferred_size(
            pixbuf.width,
            pixbuf.height
          );
          content.set_bytes(
            pixels,
            Cogl.PixelFormat.RGBA_8888,
            pixbuf.width,
            pixbuf.height,
            pixbuf.rowstride
          );

          this._notifyUser(
            message,
            'You can paste the image from the clipboard.',
            'screenshot-recorded-symbolic'
          );
        }
      );
    }

    _notifyUser(message, description, thumbnail) {
      const source = new MessageTray.Source(_('Pixzzle'), thumbnail ?? '');
      const notification = new MessageTray.Notification(
        source,
        _(message),
        _(description),
        {}
      );
      notification.setTransient(true);
      Main.messageTray.add(source);
      source.showNotification(notification);
    }

    _notifyOfEmptyView() {
      this._notifyUser(
        'No image is available',
        'Click the `Add New` button to add screenshot'
      );
    }

    _updateToolkits() {
      this._closeSnipToolkit();
    }

    _closeSnipToolkit() {
      this._isInSnipSession = false;
      this._snipIndicator.hide();
      this._ocrText.close();
    }

    _openSnipToolkit(open_always = false) {
      if (this._isPanningEnabled) {
        this._isPanningEnabled = open_always || !this._isPanningEnabled;
      }

      // Perform ocr
      lg('[UIImageRenderer::_onKeyPress]', 'setting up snip');
      this._isInSnipSession = open_always || !this._isInSnipSession;
      if (this._isInSnipSession) {
        this._snipIndicator.show();
      } else {
        this._snipIndicator.hide();
        this._ocrText.close();
      }
      this._snipIndicator.set_size(0, 0);
      this._updateCursor();
    }

    _processSnipCapture() {
      const vw = this._visibleRegionPixbuf.width;
      const vh = this._visibleRegionPixbuf.height;
      const w = this._canvas.width;
      const h = this._canvas.height;
      const oLeft = this._snipIndicator.x;
      const oTop = this._snipIndicator.y;
      const oRight = oLeft + this._snipIndicator.width - 1;
      const oBottom = oTop + this._snipIndicator.height - 1;
      const [minX, minY] = [(w - vw) / 2, (h - vh) / 2];
      const [maxX, maxY] = [(w + vw) / 2, (h + vh) / 2];
      let [startX, startY] = [minX, minY];
      let [endX, endY] = [maxX, maxY];

      if (oLeft >= startX) {
        startX = oLeft;
      }
      if (oTop >= startY) {
        startY = oTop;
      }
      if (oRight <= endX) {
        endX = oRight;
      }
      if (oBottom <= endY) {
        endY = oBottom;
      }

      if (
        startX >= minX &&
        startX <= maxX &&
        startY >= minY &&
        startY <= maxY &&
        endX >= startX &&
        endX <= maxX &&
        endY >= startY &&
        endY <= maxY
      ) {
        const width = endX - startX + 1;
        const height = endY - startY + 1;
        if (width < 10 || height < 10) {
          lg('[UIImageRenderer::_processSnipCapture]', width, height);
          this._snipIndicator.set_size(0, 0);
          return;
        }

        this._snipIndicator.set_position(startX, startY);
        this._snipIndicator.set_size(width, height);

        startX -= minX;
        startY -= minY;
        endX -= minX;
        endY -= minY;

        const pixbuf = this._visibleRegionPixbuf.new_subpixbuf(
          Math.max(startX, 0),
          Math.max(startY, 0),
          // Do this to ensure that we don't exceed the size limit of
          // the image.
          Math.min(endX - startX + 1, vw - startX),
          Math.min(endY - startY + 1, vh - startY)
        );
        if (pixbuf === null) {
          lg('[UIImageRenderer::_processSnipCapture]', 'pixbuf == (null)');
          return;
        }
        this._snipActions[this._snipTrigger]?.(pixbuf);
      } else {
        this._snipIndicator.set_size(0, 0);
      }
    }

    _doOCR(pixbuf) {
      if (this._ocrCancellable) {
        this._ocrCancellable.cancel();
        this._ocrCancellable = null;
        this._ocrResultAvailable = false;
      }

      this._ocrText.open(_('Loading...'), true /* instantly */);

      this._session = new Soup.Session({ ssl_strict: false });
      const stream = Gio.MemoryOutputStream.new_resizable();

      this._ocrCancellable = new Gio.Cancellable();
      pixbuf.save_to_streamv_async(
        stream,
        'png',
        [],
        [],
        this._ocrCancellable,
        function (pixbuf, task) {
          if (this._ocrCancellable.is_cancelled()) {
            return;
          }
          if (!GdkPixbuf.Pixbuf.save_to_stream_finish(task)) {
            return;
          }
          stream.close(null);

          const bytes = stream.steal_as_bytes();
          const multipart = new Soup.Multipart(Soup.FORM_MIME_TYPE_MULTIPART);
          multipart.append_form_string(
            'base64Image',
            'data:image/png;base64,' + GLib.base64_encode(bytes.get_data())
          );
          multipart.append_form_string('apikey', SETTING_OCR_API);
          multipart.append_form_string('OCREngine', '2');

          const message = Soup.form_request_new_from_multipart(
            OCR_URL,
            multipart
          );

          this._session.queue_message(
            message,
            function (result, task) {
              const status = message.status_code;
              if (status == Soup.Status.CANCELLED) {
                return;
              }
              if (status !== Soup.Status.OK) {
                lg(
                  '[UIImageRenderer::_processSnipCapture]',
                  'Error occurred during OCR processing:',
                  status,
                  message.response_body.length,
                  Soup.Status.get_phrase(message.status_code)
                );
                this._ocrResultAvailable = false;
                if (
                  status >= Soup.Status.CANT_RESOLVE &&
                  status <= Soup.Status.CANT_CONNECT_PROXY
                ) {
                  this._ocrText.error(
                    _(
                      'Unable to connect.\n' +
                        'Check your internet connection\n' +
                        'and try again.'
                    )
                  );
                } else if (status === Soup.Status.FORBIDDEN) {
                  this._ocrText.error(
                    _(
                      'Your API KEY is invalid.\n' +
                        'Visit https://ocr-space.com\n' +
                        'to renew your KEY'
                    )
                  );
                } else {
                  this._ocrText.error(
                    Soup.Status.get_phrase(message.status_code)
                  );
                }

                return;
              }

              const data = message.response_body.data;
              const obj = JSON.parse(
                message.response_body.length === 0 ? '{}' : data
              );
              const extract = obj?.ParsedResults?.[0]?.ParsedText?.trim() ?? '';
              lg(
                '[UIImageRenderer::_processSnipCapture]',
                'data:',
                data,
                'extract:',
                extract,
                'length:',
                extract?.length ?? 0
              );
              if (extract !== null && extract.length !== 0) {
                this._ocrText.open(extract);
              } else {
                this._ocrText.error(_('Unable to extract information'));
              }
              this._ocrResultAvailable = true;
            }.bind(this)
          );
        }.bind(this)
      );
    }

    _doCopyImage(pixbuf) {
      this._copyImageToClipboard(pixbuf, _('Selection copied'));
    }

    _doAddCutout(pixbuf) {
      this._copyImageToClipboard(pixbuf, _('Selection copied'), (bytes) => {
        const filename = storeScreenshot(bytes, pixbuf);
        this._addNewShot(filename);
      });
    }

    _addNewShot(shot) {
      this.emit('new-shot', shot);
    }

    _loadSettings() {
      this._settings = inflateSettings();
      this._settingsWatchId = this._settings.connect(
        'changed',
        this._onSettingsChange.bind(this)
      );
      this._bindSettings();
    }

    _onSettingsChange() {
      this._bindSettings();
      lg('[UIImageRenderer::_onSettingsChange]');
    }

    _bindSettings() {
      SETTING_NATURAL_PANNING = this._settings.get_boolean(
        Prefs.Fields.NATURAL_PANNING
      );

      SETTING_OCR_API = this._settings.get_string(Prefs.Fields.OCR_API);
    }

    abortSnipSession() {
      this._snipIndicator.hide();
      this._ocrText.close();
      this._session?.abort();
      this.emit('ocr-cancelled');
    }

    _updateSnipIndicator() {
      let leftX = Math.min(this._originX, this._dragX);
      let topY = Math.min(this._originY, this._dragY);
      const rightX = Math.max(this._originX, this._dragX);
      const bottomY = Math.max(this._originY, this._dragY);
      const width = rightX - leftX + 1;
      const height = bottomY - topY + 1;
      let overshootX = 0,
        overshootY = 0;

      leftX = leftX - this._anchor.x - this._anchor.border_width;
      topY = topY - this._anchor.y - this._anchor.border_width;
      if (leftX < 0) {
        overshootX = leftX;
        leftX = 0;
      }
      if (topY < 0) {
        overshootY = topY;
        topY = 0;
      }

      this._snipIndicator.set_position(leftX, topY);
      this._snipIndicator.set_size(width + overshootX, height + overshootY);
    }

    _updateCursor() {
      global.display.set_cursor(
        this._isInSnipSession ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT
      );
    }

    get ocrReady() {
      return this._ocrResultAvailable === true;
    }

    _onKeyPress(event) {
      const symbol = event.keyval;
      if (!this._canUseKey(symbol)) {
        return;
      }
      if (symbol === Clutter.KEY_Escape) {
        const before = this._snipIndicator.visible;
        this.abortSnipSession();
        // If we want to exit snip mode entirely
        const { width, height } = this._snipIndicator;
        if (!before || width < 10 || height < 10) {
          this._closeSnipToolkit();
          this._updateCursor();
        }
        return Clutter.EVENT_STOP;
      } else if (event.modifier_state & Clutter.ModifierType.CONTROL_MASK) {
        if (symbol === Clutter.KEY_r || symbol === Clutter.KEY_R) {
          this._origPixbuf = this._origPixbuf.rotate_simple(
            GdkPixbuf.PixbufRotation.CLOCKWISE
          );
          this._reOrient(1);
          this._reload();
        } else if (symbol === Clutter.KEY_l || symbol === Clutter.KEY_L) {
          this._origPixbuf = this._origPixbuf.rotate_simple(
            GdkPixbuf.PixbufRotation.COUNTERCLOCKWISE
          );
          this._reOrient(N_AXIS - 1);
          this._reload();
        } else if (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C) {
          if (event.modifier_state & Clutter.ModifierType.SHIFT_MASK) {
            this._copyImageToClipboard(
              this._visibleRegionPixbuf,
              'Viewport yanked!'
            );
          } else if (!this._isInSnipSession) {
            this._copyImageToClipboard(this._pixbuf, 'Image yanked!');
          } else {
            this._copyTextToClipboard(this._ocrText.get_text(), 'Text copied');
          }
        }
      } else if (symbol === Clutter.KEY_Delete) {
        lg(
          '[UIImageRenderer::_onKeyPress]',
          'file to be deleted:',
          this._shotWidget?._filename
        );
        const permanently = !!(
          event.modifier_state & Clutter.ModifierType.SHIFT_MASK
        );
        this._shotWidget?.emit('delete', { permanently });
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Left) {
        this.emit('switch-active', {
          current: this._filename,
          direction: Directivity.PREV
        });
        return Clutter.EVENT_STOP;
      } else if (symbol === Clutter.KEY_Right) {
        this.emit('switch-active', {
          current: this._filename,
          direction: Directivity.NEXT
        });
        return Clutter.EVENT_STOP;
      } else if (isSnipAction.bind(this)(symbol)) {
        let oldSymbol = null;
        if (event.is_simulation) {
          this._isInSnipSession && this.abortSnipSession();
        } else {
          oldSymbol = this._snipTrigger;
        }
        this._snipTrigger = symbol;
        if (!oldSymbol || !(this._isInSnipSession && oldSymbol !== symbol)) {
          this._openSnipToolkit(event.is_simulation /* open always */);
        }
      }

      function isSnipAction(symbol) {
        return !!Object.keys(this._snipActions).find((sym) => sym == symbol);
      }

      return Clutter.EVENT_PROPAGATE;
    }

    _canUseKey(symbol) {
      const imageManipKeys = Object.keys(this._snipActions);
      if (this._pixbuf == null && imageManipKeys.find((key) => symbol == key)) {
        this._notifyOfEmptyView();
        return false;
      }

      return true;
    }

    _isScaled() {
      return this._zoomToolBox.isScaled;
    }

    _onPress(event, button, sequence) {
      if (this._dragButton) {
        return Clutter.EVENT_PROPAGATE;
      }

      this._dragButton = button;
      this._dragGrab = global.stage.grab(this);
      [this._dragX, this._dragY] = [event.x, event.y];
      [this._originX, this._originY] = [event.x, event.y];
      if (this._isInSnipSession) {
        this._ocrText.close();
        this._snipIndicator.show();
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
      } else {
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
      }

      return Clutter.EVENT_STOP;
    }

    _onRelease(event, button, sequence) {
      if (
        this._dragButton !== button ||
        this._dragSequence?.get_slot() !== sequence?.get_slot()
      )
        return Clutter.EVENT_PROPAGATE;

      lg('[UIImageRenderer::_onRelease]');
      this._stopDrag();
      if (this._isInSnipSession) {
        this._processSnipCapture();
      }

      const [x, y] = [event.x, event.y];
      global.display.set_cursor(Meta.Cursor.DEFAULT);

      return Clutter.EVENT_STOP;
    }

    _stopDrag() {
      if (!this._dragButton) return;

      this._dragButton = 0;
      this._dragGrab?.dismiss();
      this._dragGrab = null;
      this._dragSequence = null;
    }

    _onMotion(event, sequence) {
      const [x, y] = [event.x, event.y];
      if (!this._dragButton) {
        this._updateCursor();
        return Clutter.EVENT_STOP;
      }

      if (!this._pixbuf) {
        return Clutter.EVENT_STOP;
      }

      let dx = Math.round(x - this._dragX);
      let dy = Math.round(y - this._dragY);

      const [maxWidth, maxHeight] = this._getBufferArea();
      if (!this._isInSnipSession) {
        if (!this._isScaled()) {
          const panDirection = SETTING_NATURAL_PANNING ? -1 : 1;
          if (maxWidth > this.width) {
            this._xpos += panDirection * dx;
            if (this._xpos < 0) {
              const overshootX = -this._xpos;
              this._xpos += overshootX;
              dx -= overshootX;
            }
            if (this._xpos + this.width - 1 >= maxWidth) {
              const overshootX = maxWidth - (this._xpos + this.width - 1);
              this._xpos += overshootX;
              dx -= overshootX;
            }
          } else {
            dx = 0;
          }

          if (maxHeight > this.height) {
            this._ypos += panDirection * dy;
            if (this._ypos < 0) {
              const overshootY = -this._ypos;
              this._ypos += overshootY;
              dy -= overshootY;
            }
            if (this._ypos + this.height - 1 >= maxHeight) {
              const overshootY = maxHeight - (this._ypos + this.height - 1);
              this._ypos += overshootY;
              dy -= overshootY;
            }
          } else {
            dy = 0;
          }
          this.emit('drag-action');
          this._canvas.invalidate();
        } else {
          const panDirection = SETTING_NATURAL_PANNING ? -1 : 1;
          const sf = this._getScale();
          const zoomWidth = this._pixbuf.get_width();
          const zoomHeight = this._pixbuf.get_height();
          if (zoomWidth > this._zoomedWidth) {
            this._zoomX += panDirection * dx;
            const zoomX = this._zoomX + this._leftX;
            if (zoomX < 0) {
              const overshootX = -zoomX;
              this._zoomX += overshootX;
              dx -= overshootX;
            }
            if (zoomX + this._zoomedWidth - 1 >= zoomWidth) {
              const overshootX = zoomWidth - (zoomX + this._zoomedWidth - 1);
              this._zoomX += overshootX;
              dx -= overshootX;
            }
          } else {
            dx = 0;
          }

          if (zoomHeight > this._zoomedHeight) {
            this._zoomY += panDirection * dy;
            const zoomY = this._zoomY + this._topY;
            if (zoomY < 0) {
              const overshootY = -zoomY;
              this._zoomY += overshootY;
              dy -= overshootY;
            }
            if (zoomY + this._zoomedHeight - 1 >= zoomHeight) {
              const overshootY = maxHeight - (zoomY + this._zoomedHeight - 1);
              this._zoomY += overshootY;
              dy -= overshootY;
            }
          } else {
            dy = 0;
          }
          this._dragZoom = true;
          this.emit('drag-action');
          this._canvas.invalidate();
        }
      } else {
        this._updateSnipIndicator();
      }

      this._dragX += dx;
      this._dragY += dy;
      return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
      this._settings.disconnect(this._settingsWatchId);
      this._settingsWatchId = null;
      this._anchor = null;
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onPress(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      )
        return this._onRelease(event, button, null);

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

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

    vfunc_enter_event(event) {
      const button = event.button;
      this.grab_key_focus();
      this._updateCursor();
      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
      global.stage.set_key_focus(global.stage);
      return Clutter.EVENT_PROPAGATE;
    }
  }
);

const UIOcrTip = GObject.registerClass(
  class UIOcrTip extends St.Label {
    _init(widget, container, params) {
      super._init(params);

      this._widget = widget;
      this._container = container;
      this._timeoutId = null;

      this.connect('destroy', this._onDestroy.bind(this));
      this._container.connect(
        'ocr-cancelled',
        function () {
          this._openCancelled = true;
          this.close();
        }.bind(this)
      );
    }

    open(message, instantly = false) {
      this.remove_style_class_name('pixzzle-ui-ocrtip-error');
      if (this._timeoutId) {
        this.close(true /* instantly */);
      }

      this._open(
        function () {
          const x = this._widget.x;
          const y = this._widget.y;
          this.show();
          this.set_text(message);
          this.set_position(x, y);
        }.bind(this),
        instantly
      );
    }

    _open(action, instantly = false) {
      if (instantly) {
        this.set_opacity(0);
        action();
        this.ease({
          opacity: Constants.FULLY_OPAQUE,
          duration: 150,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        this._openCancelled = false;
        return;
      }

      this._timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        150,
        function () {
          lg('[OcrTip::_open::timeout_add()]', this._openCancelled);
          if (this._openCancelled) {
            this._openCancelled = false;
            this.close(true /* instantly */);
          } else {
            this.set_opacity(0);
            this.show();
            action();
            this.ease({
              opacity: Constants.FULLY_OPAQUE,
              duration: 150,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
          }
          this._timeoutId = null;
          return GLib.SOURCE_REMOVE;
        }.bind(this)
      );
      GLib.Source.set_name_by_id(this._timeoutId, '[pixzzle] ocrtip._open');
    }

    close(instantly = false) {
      if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = null;
      }

      if (!this.visible) return;

      this.remove_all_transitions();
      if (instantly) {
        this.hide();
        return;
      }

      this.ease({
        opacity: 0,
        duration: 100,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this.hide()
      });
    }

    error(message) {
      lg('[OcrTip::error]', 'error:', message, this._timeoutId);
      if (this._timeoutId) {
        this.close(true /* instantly */);
      }

      this._open(
        function () {
          lg('[OcrTip::error::_open::()]');
          const style_classes = this.get_style_class_name()?.split(' ') ?? [];
          const rem_style_classes = style_classes.filter(
            (style_class) => style_class !== 'pixzzle-ui-ocrtip-error'
          );

          rem_style_classes.push('pixzzle-ui-ocrtip-error');
          this.set_style_class_name(rem_style_classes.join(' '));
          this.set_text(message);
          this._vibrateWithDamping();
        }.bind(this)
      );
    }

    _vibrateWithDamping() {
      let originalPosition = this._widget.x - this.width / 2;
      let counter = 0;
      // Change this value to adjust the rate of damping
      let dampingFactor = 1;
      function frame() {
        this.__ocrTipTimeoutId = null;
        counter += 0.9;
        // This value determines how quickly the vibration dampens
        dampingFactor *= 0.86;
        const offset = Math.sin(counter) * 80 * dampingFactor;
        // The amplitude of the vibration decreases over time
        this.set_position(originalPosition + offset, this._widget.y);

        if (dampingFactor < 0.01) {
          // When the vibration is small enough, stop the animation
          // and reset the position
          this.set_position(originalPosition, this._widget.y);
        } else {
          this.__ocrTipTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000 / 60,
            frame.bind(this)
          );
          GLib.Source.set_name_by_id(
            this.__ocrTipTimeoutId,
            '[pixzzle-ui] OcrTip.error.vibrateWithDamping.frame'
          );
        }

        return GLib.SOURCE_REMOVE;
      }

      frame.bind(this)();
    }

    _onDestroy() {
      if (this._timeoutId) {
        GLib.Source.remove(this._timeoutId);
        this._timeoutId = null;
      }

      if (this.__ocrTipTimeoutId) {
        GLib.Source.remove(this.__ocrTipTimeoutId);
        this.__ocrTipTimeoutId = null;
      }
    }

    _onMotion(event, sequence) {
      return Clutter.EVENT_STOP;
    }

    vfunc_allocate(box) {
      const [width, height] = [box.get_width(), box.get_height()];
      box.set_size(clamp(width, 300), clamp(height, 200));
      this.set_allocation(box);

      super.vfunc_allocate(box);

      function clamp(value, max) {
        return value > max ? max : value;
      }
    }

    vfunc_button_press_event(event) {
      const button = event.button;
      if (
        button === Clutter.BUTTON_PRIMARY ||
        button === Clutter.BUTTON_SECONDARY
      ) {
        if (this._container.ocrReady) {
          this._container._copyTextToClipboard(this.get_text(), 'Text copied');
        }
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    }

    vfunc_motion_event(event) {
      return this._onMotion(event, null);
    }

    vfunc_enter_event(event) {
      lg('[Tooltip::vfunc_enter_event]');
      return super.vfunc_enter_event(event);
    }
  }
);

const ZOOM_STEP = 1;
const ZOOM_SCALES = [
  0.08, 0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8,
  3, 3.2, 3.4, 3.8, 4
];
const MAX_ZOOM_LEVEL = ZOOM_SCALES.length;
const UIZoomTool = GObject.registerClass(
  class UIZoomTool extends St.Widget {
    _init(anchor) {
      super._init({ name: 'UIZoomTool', x: 0, y: 0, reactive: true });
      this._anchor = anchor;
      this._zoomLevel = this._getDefault();

      this._zoomScaleLabel = new St.Label({
        style_class: 'pixzzle-ui-zoom-scale-label',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false
      });
      this.add_child(this._zoomScaleLabel);

      this._zoomBox = new St.BoxLayout({
        style_class: 'pixzzle-ui-zoom-box',
        x_expand: true,
        y_expand: true,
        vertical: false
      });
      this.add_child(this._zoomBox);

      this._zoomIn = new St.Button({
        style_class: 'pixzzle-ui-zoom-in',
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        scale_x: 1,
        scale_y: 1,
        child: new St.Icon({
          gicon: Gio.icon_new_for_string(
            `${getIconsLocation().get_path()}/pixzzle-ui-zoom-in.png`
          )
        })
      });
      this._zoomIn.connect('enter-event', this._animateButton.bind(this));
      this._zoomIn.connect('leave-event', this._animateButton.bind(this));
      this._zoomIn.connect('clicked', this._zoomFeedIn.bind(this));
      this._zoomBox.add_child(this._zoomIn);

      this._zoomOut = new St.Button({
        style_class: 'pixzzle-ui-zoom-out',
        pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        scale_x: 1,
        scale_y: 1,
        child: new St.Icon({
          gicon: Gio.icon_new_for_string(
            `${getIconsLocation().get_path()}/pixzzle-ui-zoom-out.png`
          )
        })
      });
      this._zoomOut.connect('enter-event', this._animateButton.bind(this));
      this._zoomOut.connect('leave-event', this._animateButton.bind(this));
      this._zoomOut.connect('clicked', this._zoomFeedOut.bind(this));
      this._zoomBox.add_child(this._zoomOut);

      this._zoomBox.add_constraint(
        new Clutter.AlignConstraint({
          source: this._anchor,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          factor: 1
        })
      );
      this._zoomBox.add_constraint(
        new Clutter.AlignConstraint({
          source: this._anchor,
          align_axis: Clutter.AlignAxis.X_AXIS,
          factor: 0.5
        })
      );

      this._zoomScaleLabel.add_constraint(
        new Clutter.AlignConstraint({
          source: this._anchor,
          align_axis: Clutter.AlignAxis.X_AXIS,
          pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
          factor: 0.5
        })
      );

      this._updateZoomLabel();
    }

    _zoomFeedOut(button) {
      if (this._zoomLevel === 0) {
        this._zoomOut.add_style_class_name('zoom-disabled');
        return;
      }

      this._zoomOut.remove_style_class_name('zoom-disabled');
      this._zoomLevel -= ZOOM_STEP;
      this._updateZoomLabel();
      this._anchor._loadScaled();
      lg('[UIZoomTool::_zoomFeedOut] zoomFactor:', this.zoomFactor);
    }

    _zoomFeedIn(button) {
      if (this._zoomLevel >= MAX_ZOOM_LEVEL - 1) {
        this._zoomIn.add_style_class_name('zoom-disabled');
        return;
      }

      this._zoomIn.remove_style_class_name('zoom-disabled');
      this._zoomLevel += ZOOM_STEP;
      this._updateZoomLabel();
      this._anchor._loadScaled();
      lg('[UIZoomTool::_zoomFeedOut] zoomFactor:', this.zoomFactor);
    }

    get zoomFactor() {
      return ZOOM_SCALES[this._zoomLevel];
    }

    get isScaled() {
      return this.zoomFactor !== 1;
    }

    resetZoom() {
      this._zoomLevel = this._getDefault();
      this._updateZoomLabel();
    }

    _updateZoomLabel() {
      const percentage = Math.round(this.zoomFactor * 100);
      this._zoomScaleLabel.set_text(`${percentage}%`);
    }

    _getDefault() {
      return ZOOM_SCALES.indexOf(1);
    }

    _animateButton(button) {
      const scale_offsets = [1, 1.1];
      const scaleXOff = scale_offsets[Number(button.scale_x <= 1)];
      const scaleYOff = scale_offsets[Number(button.scale_y <= 1)];
      button.ease({
        scale_x: scaleXOff,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_BOUNCE
      });
      button.ease({
        scale_y: scaleYOff,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_BOUNCE
      });
    }
  }
);
