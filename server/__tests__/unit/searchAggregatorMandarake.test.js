const mockMandarakeSearch = jest.fn();

jest.mock('../../models/settings', () => ({
    get: () => ({
        enabledSites: {
            mercari: true,
            yahoo: true,
            paypay: true,
            fril: true,
            surugaya: true,
            taobao: false,
            goofish: false,
            mandarake: true
        },
        strictFiltering: {
            mercari: true,
            yahoo: true,
            paypay: true,
            fril: true,
            surugaya: true,
            taobao: true,
            goofish: true,
            mandarake: true
        }
    })
}));

jest.mock('../../scrapers/mercari', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/yahoo', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/paypay', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/fril', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/surugaya', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/taobao', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/goofish', () => ({ search: jest.fn().mockResolvedValue([]) }));
jest.mock('../../scrapers/mandarake', () => {
    const actual = jest.requireActual('../../scrapers/mandarake');
    return {
        ...actual,
        search: mockMandarakeSearch
    };
});

const searchAggregator = require('../../scrapers');

describe('search aggregator Mandarake integration', () => {
    beforeEach(() => {
        mockMandarakeSearch.mockReset();
    });

    test('strict-filters Mandarake garage-kit searches with the stripped base query', async () => {
        mockMandarakeSearch.mockResolvedValue([
            {
                title: 'Fate Saber Resin Statue',
                link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=saber&ref=list',
                image: '',
                price: '¥12,000'
            },
            {
                title: 'Fate Rin Resin Statue',
                link: 'https://order.mandarake.co.jp/order/detailPage/item?itemCode=rin&ref=list',
                image: '',
                price: '¥11,000'
            }
        ]);

        const results = await searchAggregator.searchAll(
            'Saber ガレージキット',
            {
                mercari: false,
                yahoo: false,
                paypay: false,
                fril: false,
                surugaya: false,
                taobao: false,
                goofish: false,
                mandarake: true
            },
            true,
            [],
            null,
            { mandarake: { mode: 'garageKit' } }
        );

        expect(mockMandarakeSearch).toHaveBeenCalledWith(
            'Saber ガレージキット',
            true,
            [],
            { mode: 'garageKit' }
        );
        expect(results.map(item => item.title)).toEqual(['Fate Saber Resin Statue']);
    });
});
