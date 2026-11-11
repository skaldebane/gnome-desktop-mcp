import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// XDG_RUNTIME_DIR (/run/user/UID) is owned by the user and mode 0700, so no
// other local user can pre-create this path, swap it for a symlink, or read
// what lands in it. /tmp would be world-writable and racy.
const SCREENSHOT_DIR = GLib.build_filenamev([
    GLib.get_user_runtime_dir(),
    'gnome-mcp',
]);
const SCREENSHOT_PREFIX = 'screenshot-';
const SCREENSHOT_SUFFIX = '.png';
let _counter = 0;

function _ensureDir() {
    GLib.mkdir_with_parents(SCREENSHOT_DIR, 0o700);
}

function _nextFilename() {
    _counter++;
    return GLib.build_filenamev([
        SCREENSHOT_DIR,
        `${SCREENSHOT_PREFIX}${Date.now()}-${_counter}${SCREENSHOT_SUFFIX}`,
    ]);
}

function _createStream(filepath) {
    const file = Gio.File.new_for_path(filepath);
    return file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
}

function _getMonitors() {
    const display = global.display;
    const nMonitors = display.get_n_monitors();
    const monitors = [];
    for (let i = 0; i < nMonitors; i++) {
        const rect = display.get_monitor_geometry(i);
        monitors.push({
            index: i,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
        });
    }
    return monitors;
}

function _monitorIntersectsArea(monitor, x, y, right, bottom) {
    return x < monitor.right && right > monitor.x &&
        y < monitor.bottom && bottom > monitor.y;
}

function _monitorContainsArea(monitor, x, y, right, bottom) {
    return x >= monitor.x && y >= monitor.y &&
        right <= monitor.right && bottom <= monitor.bottom;
}

function _areaError(x, y, width, height, right, bottom, intersecting) {
    const indexes = intersecting.length > 0
        ? intersecting.map(monitor => monitor.index).join(', ')
        : 'none';
    return `ScreenshotFailed: Requested area (x=${x}, y=${y}, width=${width}, height=${height}, right=${right}, bottom=${bottom}) is not fully contained within a single monitor. It intersects monitor(s): ${indexes}. Call get_monitors to query valid monitor bounds before retrying.`;
}

export function screenshotFull(includeCursor, invocation) {
    _ensureDir();
    const filepath = _nextFilename();
    const stream = _createStream(filepath);
    const screenshot = new Shell.Screenshot();

    screenshot.screenshot(includeCursor, stream, (source, result) => {
        try {
            screenshot.screenshot_finish(result);
            stream.close(null);
            invocation.return_value(GLib.Variant.new('(s)', [filepath]));
        } catch (e) {
            stream.close(null);
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.FAILED,
                `ScreenshotFailed: ${e.message}`);
        }
    });
}

export function screenshotWindow(includeCursor, includeFrame, invocation, onComplete = null) {
    _ensureDir();
    const filepath = _nextFilename();
    const stream = _createStream(filepath);
    const screenshot = new Shell.Screenshot();

    screenshot.screenshot_window(includeFrame, includeCursor, stream, (source, result) => {
        try {
            screenshot.screenshot_window_finish(result);
            stream.close(null);
            if (onComplete) onComplete();
            invocation.return_value(GLib.Variant.new('(s)', [filepath]));
        } catch (e) {
            stream.close(null);
            if (onComplete) onComplete();
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.FAILED,
                `ScreenshotFailed: ${e.message}`);
        }
    });
}

export function screenshotArea(x, y, width, height, includeCursor, invocation) {
    const right = x + width;
    const bottom = y + height;

    if (width < 1 || height < 1) {
        invocation.return_error_literal(
            Gio.DBusError, Gio.DBusError.FAILED,
            _areaError(x, y, width, height, right, bottom, []));
        return;
    }

    const monitors = _getMonitors();
    const intersecting = monitors.filter(monitor =>
        _monitorIntersectsArea(monitor, x, y, right, bottom));
    const containing = monitors.filter(monitor =>
        _monitorContainsArea(monitor, x, y, right, bottom));
    if (containing.length !== 1) {
        invocation.return_error_literal(
            Gio.DBusError, Gio.DBusError.FAILED,
            _areaError(x, y, width, height, right, bottom, intersecting));
        return;
    }

    _ensureDir();
    const filepath = _nextFilename();
    const stream = _createStream(filepath);
    const screenshot = new Shell.Screenshot();

    screenshot.screenshot_area(x, y, width, height, stream, (source, result) => {
        try {
            screenshot.screenshot_area_finish(result);
            stream.close(null);
            invocation.return_value(GLib.Variant.new('(s)', [filepath]));
        } catch (e) {
            stream.close(null);
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.FAILED,
                `ScreenshotFailed: ${e.message}`);
        }
    });
}

export function pickColor(x, y, invocation) {
    const screenshot = new Shell.Screenshot();

    screenshot.pick_color(x, y, (source, result) => {
        try {
            const color = screenshot.pick_color_finish(result);
            // Cogl.Color exposes float channels (0.0-1.0) since Mutter 47 and
            // 0-255 ints before; NaN means the field could not be read.
            const norm = (v) => {
                if (typeof v !== 'number' || isNaN(v)) return 0.0;
                return v > 1.0 ? v / 255.0 : v;
            };
            invocation.return_value(GLib.Variant.new('(ddd)', [
                norm(color.red),
                norm(color.green),
                norm(color.blue),
            ]));
        } catch (e) {
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.FAILED,
                `ScreenshotFailed: ${e.message}`);
        }
    });
}

export function cleanupScreenshots() {
    let count = 0;
    const dir = Gio.File.new_for_path(SCREENSHOT_DIR);
    if (!dir.query_exists(null))
        return count;

    const enumerator = dir.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        // Only ever delete files this module created.
        const name = info.get_name();
        if (!name.startsWith(SCREENSHOT_PREFIX) || !name.endsWith(SCREENSHOT_SUFFIX))
            continue;
        try {
            if (dir.get_child(name).delete(null))
                count++;
        } catch (e) {
            logError(e, `[DesktopAutomation] failed to delete ${name}`);
        }
    }
    enumerator.close(null);
    return count;
}
