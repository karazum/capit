// SPDX-License-Identifier: GPL-3.0-or-later
import {serve, Window} from '../../extension/accessibility.js';
import {assert, test} from './harness.js';

// A fake accessible: extents in window coordinates, answering hit tests one level at a time.
class Node {
    constructor(name, x, y, width, height, children = []) {
        this.name = name;
        this.rect = {x, y, width, height};
        this.children = children;
        this.parent = null;
        for (const child of children)
            child.parent = this;
    }

    get_name() {
        return this.name;
    }

    get_extents() {
        return this.rect;
    }

    get_parent() {
        return this.parent;
    }

    get_child_count() {
        return this.children.length;
    }

    get_child_at_index(index) {
        return this.children[index];
    }

    get_accessible_at_point(x, y) {
        return this.children.find(({rect}) => rect.x <= x && x < rect.x + rect.width &&
            rect.y <= y && y < rect.y + rect.height) ?? null;
    }
}

class App extends Node {
    constructor(pid, frames) {
        super('app', 0, 0, 0, 0, frames);
        this.pid = pid;
    }

    get_process_id() {
        return this.pid;
    }
}

// A window with a sidebar holding one item; `scale` multiplies every reported coordinate.
function filesWindow(scale = 1) {
    const node = (name, x, y, width, height, children = []) =>
        new Node(name, x * scale, y * scale, width * scale, height * scale, children);
    const item = node('Documents', 6, 166, 168, 36);
    const sidebar = node('Sidebar', 0, 46, 180, 504, [item]);
    // A wrapper with the same bounds as the sidebar adds a scroll step that changes nothing, so it is dropped.
    const wrapper = node('', 0, 46, 180, 504, [sidebar]);
    const icon = node('icon', 10, 170, 4, 4);
    item.children.push(icon);
    icon.parent = item;
    return node('Files', 0, 0, 890, 550, [wrapper, node('', 180, 46, 710, 504)]);
}

function atspi(...apps) {
    const desktop = new Node('desktop', 0, 0, 0, 0, apps);
    return {get_desktop: () => desktop, CoordType: {WINDOW: 1}, set_timeout: () => {}};
}

const window = (library, title = 'Files') =>
    new Window({pid: 42, title, client: [1000, 200, 890, 550]}, library);

test('boxes around the point run innermost first, in stage coordinates', () => {
    const found = window(atspi(new App(42, [new Node('Other', 0, 0, 300, 200), filesWindow()]))).elements(1090, 380);
    assert.deepEqual(found, [[1006, 366, 168, 36], [1000, 246, 180, 504]]);
});

test('an application reporting device pixels is scaled to logical ones', () => {
    assert.deepEqual(window(atspi(new App(42, [filesWindow(1.25)]))).elements(1090, 380)[1], [1000, 246, 180, 504]);
});

test('a window without a matching application has no boxes', () => {
    assert.deepEqual(window(atspi(new App(7, [filesWindow()]))).elements(1090, 380), []);
});

test('an unmatched window of a process with several is not guessed', () => {
    const library = atspi(new App(42, [new Node('Other', 0, 0, 300, 200), new Node('Another', 0, 0, 640, 100)]));
    assert.deepEqual(window(library).elements(1090, 380), []);
});

test('the only window of a process is used even when its name differs', () => {
    const renamed = filesWindow();
    renamed.name = 'Home';
    assert.deepEqual(window(atspi(new App(42, [renamed]))).elements(1090, 380)[1], [1000, 246, 180, 504]);
});

test('an application that answers no hit tests is searched by its elements\' extents', () => {
    const files = filesWindow();
    const silence = node => {
        node.get_accessible_at_point = () => null;
        node.children.forEach(silence);
    };
    silence(files);
    const found = window(atspi(new App(42, [files]))).elements(1090, 380);
    assert.deepEqual(found, [[1006, 366, 168, 36], [1000, 246, 180, 504]]);
});

test('hover questions are answered by id', () => {
    const sent = [];
    serve([JSON.stringify({windows: [{index: 3, pid: 42, title: 'Files', client: [1000, 200, 890, 550]}]}),
        JSON.stringify({id: 9, index: 3, x: 1090, y: 380}), JSON.stringify({id: 10, index: 8, x: 1, y: 1})],
    message => sent.push(message), atspi(new App(42, [filesWindow()])));
    assert.deepEqual(sent[0], {ready: true});
    assert.equal(sent[1].id, 9);
    assert.equal(sent[1].elements.length, 2);
    assert.deepEqual(sent[2], {id: 10, index: 8, elements: []});
});

test('a failing application gives no boxes instead of stopping the finder', () => {
    const broken = filesWindow();
    broken.get_accessible_at_point = () => {
        throw new Error('timed out');
    };
    const sent = [];
    serve([JSON.stringify({windows: [{index: 0, pid: 42, title: 'Files', client: [1000, 200, 890, 550]}]}),
        JSON.stringify({id: 1, index: 0, x: 1090, y: 380})], message => sent.push(message), atspi(new App(42, [broken])));
    assert.deepEqual(sent[1], {id: 1, index: 0, elements: []});
});

test('without AT-SPI the finder reports itself unavailable', () => {
    const sent = [];
    serve([], message => sent.push(message), null, 'no typelib');
    assert.ok(/unavailable|no typelib/.test(JSON.stringify(sent[0])), JSON.stringify(sent));
    assert.ok('unavailable' in sent[0]);
});
