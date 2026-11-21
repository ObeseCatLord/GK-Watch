const frames = [
    '(o-o) *',
    '(o-o) +',
    '(o-o) .',
    '(o-o)  ',
    '(o-O)  ',
    '(O-O) .',
    '(O-o) +',
    '(o-o) *',
    '(o-o) +',
    '(-_-) .',
    '(-_-)  ',
    '(o-o) .'
];

export default function ScanIndicator() {
    return (
        <span className="scan-indicator" aria-hidden="true" style={{ '--frames': frames.length }}>
            <span className="scan-frames">
                {frames.map((frame, index) => <span key={index}>{frame}</span>)}
            </span>
        </span>
    );
}
