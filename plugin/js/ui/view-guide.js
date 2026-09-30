'use strict';
// Guide: how Folder Suggest works and how to use each part, in plain words.

const { h, icon } = require('./dom');

function create(app) {
	const el = h('div.page.guide');

	const k = (t) => h('kbd', t);
	const b = (t) => h('b', t);

	function section(ic, title, ...body) {
		return h('div.card.g-sec', h('div.card-head', icon(ic, 17), h('h2', title)), h('div.card-body', ...body));
	}
	const p = (...c) => h('p', ...c);
	const ul = (...items) => h('ul', ...items.map((c) => h('li', ...[].concat(c))));
	const go = (label, view, opts) => h('button.btn.small', { onclick: () => app.navigate(view, opts) }, label);

	function render() {
		el.replaceChildren();
		el.append(
			h('div.page-head', h('h1', 'Guide'), h('span.sub', 'How Folder Suggest works and how to use it')),

			section('sparkle', 'What it does',
				p('Folder Suggest learns what the videos in each of your folders look like. Then, for any video, it tells you which folder it belongs in. You move it with one click or one key press.'),
				p('It never moves anything by itself. Every move can be undone.')),

			section('folder', 'Step 1: tell it which folders are your "sorted" folders',
				p('Under ', b('Settings > Folders to learn'), ', tick the folders you sort videos ', b('into'), ' and untick the folder new videos ', b('arrive in'), ' (for example "Animations Approved").'),
				ul(
					['Videos in ticked folders are "sorted". The plugin learns from them, and only ticked folders are ever suggested.'],
					['Videos in unticked folders (or in no folder) are ', b('waiting to be sorted'), '. They show up in the Sort page\'s first list.'],
				),
				h('div', go('Open Folders to learn', 'settings'))),

			section('eye', 'While browsing in Eagle: the sidebar box',
				p('Click a video in Eagle. In the right sidebar there is a ', b('Folder Suggest'), ' box (scroll down in the sidebar if you do not see it). It lists three folders:'),
				ul(
					['The ', b('top one'), ' is where the plugin thinks the video belongs; the % is how confident it is.'],
					[b('Green'), ' means "sure": suggestions that confident were right about 9 times out of 10 on your own videos.'],
					[b('Click a folder'), ' and the video moves there. The box then offers ', b('Undo'), '.'],
					[b('"Looks right"'), ' means the video is already in the folder the plugin would pick.'],
					['While the box has focus you can also press ', k('1'), ' ', k('2'), ' ', k('3'), ' to move, and ', k('Z'), ' to undo.'],
				)),

			section('sortIn', 'Many videos at once: the Sort page',
				p('One video at a time, big, with the same suggestions. Keys:'),
				h('div.g-keys',
					h('span', k('1'), k('2'), k('3'), ' move it to that folder'),
					h('span', k('Enter'), ' move it to the first suggestion'),
					h('span', k('S'), ' skip (in "Might be misplaced": keep it where it is)'),
					h('span', k('←'), ' back'),
					h('span', k('Scroll wheel'), ' next / previous video'),
					h('span', k('Z'), ' undo the last move'),
					h('span', k('Space'), ' play the video'),
					h('span', k('F'), ' move it to any other folder (type to search)')),
				p('At the top you choose which videos to go through:'),
				ul(
					[b('Waiting to be sorted'), ': videos not in any sorted folder yet. ', b('This is the everyday one'), ': after adding new videos, go through this list.'],
					[b('Might be misplaced'), ': videos you already sorted that the plugin would put in a different folder. Some are real mistakes (a Tifa video in Aerith\'s folder), some are the plugin being wrong. Press ', k('1'), ' to move it, or ', k('S'), ' if it is right; it will not be listed again.'],
					[b('A folder'), ': every video in one folder.'],
					[b('Selected in Eagle'), ': the videos you have selected in Eagle right now.'],
				),
				h('div', go('Open the Sort page', 'sort'))),

			section('sparkle', 'Move all sure',
				p('On the Sort page, ', b('Move all sure'), ' moves every video in the current list whose first suggestion is green, in one go. You see how many before it starts, and one Undo reverses the whole batch.'),
				p('It is not offered in "Might be misplaced": there, look at each video yourself.')),

			section('undo', 'What a move does',
				ul(
					['The video leaves its old folder and goes into the new one (like Eagle\'s own "Move to").'],
					['The old folder\'s auto-tags are taken off and the new folder\'s are added. Tags you added yourself stay. (Both can be switched off under Settings > Moving.)'],
					[b('Undo'), ' puts the video and its tags back: ', k('Z'), ' on the Sort page, the Undo link in the sidebar box, or Undo last on the Overview.'],
				)),

			section('film', 'How it keeps up',
				ul(
					['It reads each video\'s Eagle thumbnail once (its "fingerprint"). That is the long first run; afterwards only new videos are read.'],
					['New videos are noticed within about 15 seconds.'],
					['After you move videos it relearns by itself about 20 seconds later, so suggestions get better the more you sort.'],
					['The graphics card is only used while fingerprinting; it is freed after two quiet minutes.'],
				)),

			section('overview', 'The numbers on the Overview',
				p('While learning, the plugin hides one in ten of your sorted videos from itself and then checks how it does on them:'),
				ul(
					[b('First pick right'), ': how often the top suggestion is the folder you chose.'],
					[b('Right folder in top 3'), ': how often your folder is one of the three suggestions.'],
					[b('Marked sure'), ': how many videos get a green suggestion, and how often those are right.'],
				)),
		);
	}

	return { el, show: render, hide() {} };
}

module.exports = { create };
