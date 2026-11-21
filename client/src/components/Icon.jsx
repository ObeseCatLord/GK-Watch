const glyphs = {
    folder: '\uf07b',
    search: '\uf002',
    list: '\uf03a',
    settings: '\uf013',
    run: '\uf04b',
    refresh: '\uf021',
    block: '\uf05e',
    add: '\uf067',
    chevron: '\uf078',
    clock: '\uf017'
};

const bitmaps = {
    close: 'close',
    edit: 'pencil',
    favorite: 'star',
    unfavorite: 'star',
    trash: 'trash',
    external: 'external-link'
};

export default function Icon({ name }) {
    if (bitmaps[name]) {
        return <span className={`bitmap-icon bitmap-icon--${bitmaps[name]}`} aria-hidden="true" />;
    }
    return <span className="ui-icon" aria-hidden="true">{glyphs[name]}</span>;
}
