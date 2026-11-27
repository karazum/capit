# SPDX-License-Identifier: GPL-3.0-or-later
"""What a detector should find in each corpus capture, curated by eye from the captures.

Rectangles are [x, y, width, height] in logical pixels relative to the window image. An entry
given as a string instead is the name of an accessible element whose rectangle is used, which
is how the IDE page's panels are found at whatever size its window got.

`must` are panels with visible edges that a hover should be able to outline. `optional` are
elements that are fine to find, and that hover points may name, but that not every theme
draws an edge for. A point names the panels it should outline, best first; `children` says
whether a smaller element inside that panel is as good. `clean` are zones no box may cut
through or sit inside: running text and pictures.
"""

IDE = {
    'must': {'title bar': 'title bar', 'activity bar': 'activity bar', 'sidebar': 'sidebar', 'tab strip': 'tab strip',
             'editor': 'editor', 'preview': 'preview', 'terminal': 'terminal', 'status bar': 'status bar',
             'card': 'card'},
    'optional': {'breadcrumbs': 'breadcrumbs', 'editor group': ('union', 'breadcrumbs', 'editor', 'preview'),
                 'photo': ('offset', 'preview', [21, 80, 300, 160])},
    'points': [
        {'in': 'sidebar', 'at': [0.5, 0.8], 'expect': ['sidebar']},
        {'in': 'sidebar', 'at': [0.5, 0.17], 'expect': ['sidebar'], 'children': True},
        {'in': 'activity bar', 'at': [0.5, 0.8], 'expect': ['activity bar']},
        {'in': 'editor', 'at': [0.6, 0.6], 'expect': ['editor', 'editor group']},
        # On the current line, and on the selected text in it.
        {'in': 'editor', 'at': [0.7, 0.44], 'expect': ['editor', 'editor group']},
        {'in': 'editor', 'at': [0.37, 0.44], 'expect': ['editor', 'editor group']},
        {'in': 'preview', 'at': [0.5, 0.9], 'expect': ['preview', 'editor group']},
        {'in': 'photo', 'at': [0.5, 0.5], 'expect': ['photo', 'preview']},
        {'in': 'card', 'at': [0.5, 0.5], 'expect': ['card']},
        {'in': 'terminal', 'at': [0.7, 0.6], 'expect': ['terminal']},
        {'in': 'terminal', 'at': [0.1, 0.5], 'expect': ['terminal']},
        {'in': 'tab strip', 'at': [0.9, 0.5], 'expect': ['tab strip'], 'children': True},
        {'in': 'tab strip', 'at': [0.03, 0.5], 'expect': ['tab strip'], 'children': True},
        {'in': 'status bar', 'at': [0.5, 0.5], 'expect': ['status bar']},
        {'in': 'title bar', 'at': [0.5, 0.5], 'expect': ['title bar']},
    ],
    'clean': [('inset', 'editor', [70, 12, 30, 12]), ('inset', 'photo', [6, 6, 6, 6])],
}

FILES = {
    'must': {'sidebar': [0, 0, 180, 550], 'main': [180, 0, 710, 550]},
    'optional': {'header bar': [180, 0, 710, 46], 'content': [180, 46, 710, 504], 'path bar': [284, 6, 365, 34]},
    'points': [
        {'at': [90, 400], 'expect': ['sidebar']},
        {'at': [90, 108], 'expect': ['sidebar'], 'children': True},
        {'at': [90, 197], 'expect': ['sidebar'], 'children': True},
        {'at': [500, 400], 'expect': ['content', 'main']},
        {'at': [251, 95], 'expect': ['content', 'main'], 'children': True},
        {'at': [460, 23], 'expect': ['path bar', 'header bar', 'main']},
        {'at': [690, 23], 'expect': ['header bar', 'main'], 'children': True},
    ],
    'clean': [],
}

EDITOR = {
    'must': {'header bar': [0, 0, 700, 46], 'text': [0, 46, 700, 474]},
    'optional': {},
    'points': [
        {'at': [350, 300], 'expect': ['text']},
        {'at': [100, 100], 'expect': ['text']},
        {'at': [650, 500], 'expect': ['text']},
        {'at': [150, 23], 'expect': ['header bar'], 'children': True},
        {'at': [350, 23], 'expect': ['header bar'], 'children': True},
    ],
    'clean': [('rect', [10, 56, 680, 454])],
}

# Opened with a second document, so the header holds a row of tabs.
EDITOR_TABS = {
    'must': {'header bar': [0, 0, 700, 87], 'text': [0, 87, 700, 433]},
    'optional': {'tab': [351, 45, 344, 36]},
    'points': [
        {'at': [350, 300], 'expect': ['text']},
        {'at': [100, 120], 'expect': ['text']},
        {'at': [650, 500], 'expect': ['text']},
        {'at': [150, 23], 'expect': ['header bar'], 'children': True},
        {'at': [180, 64], 'expect': ['header bar'], 'children': True},
        {'at': [520, 64], 'expect': ['tab', 'header bar']},
    ],
    'clean': [('rect', [10, 96, 680, 414])],
}

SETTINGS_SIDEBAR = [
    {'at': [242, 300], 'expect': ['sidebar']},
    {'at': [120, 250], 'expect': ['sidebar'], 'children': True},
    {'at': [120, 540], 'expect': ['sidebar'], 'children': True},
    {'at': [290, 300], 'expect': ['content']},
    {'at': [612, 23], 'expect': ['content'], 'children': True},
]

SETTINGS_KEYBOARD = {
    'must': {'sidebar': [0, 0, 245, 640], 'content': [245, 0, 735, 640], 'card 1': [333, 124, 559, 109],
             'card 2': [333, 329, 559, 109], 'card 3': [333, 516, 559, 109]},
    'optional': {'selected row': [5, 356, 235, 44]},
    'points': SETTINGS_SIDEBAR + [
        {'at': [120, 384], 'expect': ['selected row', 'sidebar']},
        {'at': [400, 78], 'expect': ['content']},
        {'at': [800, 150], 'expect': ['card 1'], 'children': True},
        {'at': [800, 410], 'expect': ['card 2'], 'children': True},
        {'at': [612, 540], 'expect': ['card 3'], 'children': True},
    ],
    'clean': [],
}

SETTINGS_MOUSE = {
    'must': {'sidebar': [0, 0, 245, 640], 'content': [245, 0, 735, 640], 'card 1': [333, 110, 559, 63],
             'card 2': [333, 237, 559, 392]},
    'optional': {'selected row': [5, 321, 235, 44]},
    'points': SETTINGS_SIDEBAR + [
        {'at': [120, 340], 'expect': ['selected row', 'sidebar']},
        {'at': [400, 85], 'expect': ['content']},
        {'at': [450, 140], 'expect': ['card 1'], 'children': True},
        {'at': [450, 265], 'expect': ['card 2'], 'children': True},
        {'at': [612, 372], 'expect': ['card 2'], 'children': True},
    ],
    'clean': [('rect', [372, 422, 206, 118]), ('rect', [650, 422, 206, 118])],
}

CALCULATOR = {
    'must': {'header bar': [0, 0, 360, 46], 'history': [0, 46, 360, 118], 'entry': [0, 164, 360, 67],
             'keypad': [0, 231, 360, 260]},
    'optional': {},
    'points': [
        {'at': [180, 100], 'expect': ['history']},
        {'at': [180, 200], 'expect': ['entry']},
        {'at': [5, 400], 'expect': ['keypad']},
        {'at': [44, 265], 'expect': ['keypad'], 'children': True},
        {'at': [130, 23], 'expect': ['header bar'], 'children': True},
    ],
    'clean': [],
}

ARTICLE = {
    'must': {'navigation bar': 'navigation bar', 'side menu': 'side menu', 'picture': 'picture', 'card one': 'card one',
             'card two': 'card two', 'card three': 'card three', 'code block': 'code block', 'table': 'table',
             'footer': 'footer'},
    'optional': {'search field': 'search field'},
    'points': [
        {'in': 'navigation bar', 'at': [0.5, 0.5], 'expect': ['navigation bar']},
        {'in': 'search field', 'at': [0.5, 0.5], 'expect': ['search field', 'navigation bar']},
        {'in': 'side menu', 'at': [0.5, 0.8], 'expect': ['side menu']},
        {'in': 'side menu', 'at': [0.5, 0.14], 'expect': ['side menu'], 'children': True},
        {'in': 'picture', 'at': [0.5, 0.5], 'expect': ['picture']},
        {'in': 'picture', 'at': [0.2, 0.8], 'expect': ['picture']},
        {'in': 'card two', 'at': [0.5, 0.5], 'expect': ['card two']},
        {'in': 'card three', 'at': [0.9, 0.9], 'expect': ['card three']},
        {'in': 'code block', 'at': [0.5, 0.5], 'expect': ['code block']},
        {'in': 'table', 'at': [0.5, 0.6], 'expect': ['table'], 'children': True},
        {'in': 'footer', 'at': [0.5, 0.5], 'expect': ['footer']},
    ],
    'clean': [('inset', 'picture', [6, 6, 6, 6])],
}

TRUTH = {'article-wayland': ARTICLE, 'article-xwayland': ARTICLE, 'ide-wayland': IDE, 'ide-xwayland': IDE, 'files-dark': FILES, 'files-light': FILES,
         'editor-dark': EDITOR, 'editor-light': EDITOR_TABS, 'settings-dark': SETTINGS_KEYBOARD,
         'settings-light': SETTINGS_MOUSE, 'calculator-light': CALCULATOR}
