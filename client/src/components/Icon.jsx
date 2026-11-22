const bitmaps = {
    folder: 'folder',
    search: 'search',
    list: 'list-box',
    settings: 'settings-cog',
    run: 'play',
    refresh: 'refresh',
    block: 'cancel',
    add: 'plus',
    clock: 'clock',
    check: 'check',
    close: 'close',
    edit: 'pencil',
    favorite: 'star-filled',
    unfavorite: 'star',
    trash: 'trash',
    external: 'external-link'
};

export default function Icon({ name }) {
    const bitmap = bitmaps[name];
    return (
        <span className={`bitmap-icon bitmap-icon--${bitmap}`}
            style={{ '--bitmap': `url("/icons/${bitmap}.png")` }} aria-hidden="true" />
    );
}
