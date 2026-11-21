import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ResultCard from './ResultCard';

const listing = { title: 'Garage kit', link: 'https://example.test/kit' };

describe('listing price slots', () => {
    it.each(['Mercari', 'PayPay Flea Market', 'Suruga-ya', 'Mandarake', 'Goofish'])(
        'places a fixed-price %s listing in the Buy slot',
        (source) => {
            const { container } = render(<ResultCard item={{ ...listing, source, price: '¥3,000' }} />);
            expect(container.querySelector('.buy-price')).toHaveTextContent('¥3,000 buy');
            expect(container.querySelector('.bid-price')).toBeNull();
        }
    );

    it.each([
        [{ bidPrice: '¥1,200', binPrice: 'N/A' }, '¥1,200 bid', null],
        [{ bidPrice: 'N/A', binPrice: '¥4,000' }, null, '¥4,000 buy'],
        [{ bidPrice: '¥1,200', binPrice: '¥4,000' }, '¥1,200 bid', '¥4,000 buy'],
        [{ price: 'N/A', bidPrice: 'N/A', binPrice: 'N/A' }, null, null]
    ])('keeps the price in its slot and omits unavailable values', (prices, bid, buy) => {
        const { container } = render(<ResultCard item={{ ...listing, ...prices, source: 'Yahoo Auctions' }} />);
        expect(container.querySelector('.bid-price')?.textContent ?? null).toBe(bid);
        expect(container.querySelector('.buy-price')?.textContent ?? null).toBe(buy);
        expect(screen.queryByText(/N\/A/)).not.toBeInTheDocument();
    });
});
