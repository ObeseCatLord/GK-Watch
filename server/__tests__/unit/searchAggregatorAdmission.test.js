const mockSearchPoolRun = jest.fn(task => Promise.resolve().then(task));
const mockHttpPoolRun = jest.fn(task => Promise.resolve().then(task));
const mockBrowserPoolRun = jest.fn(task => Promise.resolve().then(task));

const mockMercariSearch = jest.fn();
const mockYahooSearch = jest.fn();
const mockPaypaySearch = jest.fn();
const mockFrilSearch = jest.fn();
const mockSurugayaSearch = jest.fn();
const mockTaobaoSearch = jest.fn();
const mockGoofishSearch = jest.fn();
const mockMandarakeSearch = jest.fn();

jest.mock('../../utils/admissionControl', () => ({
    searchPool: { run: mockSearchPoolRun, stats: () => ({}) },
    httpPool: { run: mockHttpPoolRun, stats: () => ({}) },
    mercariFreshnessPool: { stats: () => ({}) },
    browserPool: { run: mockBrowserPoolRun, stats: () => ({}) }
}));

jest.mock('../../models/settings', () => ({
    get: () => ({
        enabledSites: {},
        strictFiltering: {},
        allowYahooInternationalShipping: false
    })
}));

jest.mock('../../scrapers/mercari', () => ({ search: mockMercariSearch }));
jest.mock('../../scrapers/yahoo', () => ({ search: mockYahooSearch }));
jest.mock('../../scrapers/paypay', () => ({ search: mockPaypaySearch }));
jest.mock('../../scrapers/fril', () => ({ search: mockFrilSearch }));
jest.mock('../../scrapers/surugaya', () => ({ search: mockSurugayaSearch }));
jest.mock('../../scrapers/taobao', () => ({ search: mockTaobaoSearch }));
jest.mock('../../scrapers/goofish', () => ({ search: mockGoofishSearch }));
jest.mock('../../scrapers/mandarake', () => ({ search: mockMandarakeSearch }));

const searchAggregator = require('../../scrapers');

const enabledBrowserAndHttpSites = {
    mercari: true,
    yahoo: true,
    paypay: false,
    fril: false,
    surugaya: false,
    taobao: true,
    goofish: true,
    mandarake: false
};

describe('search aggregator admission and cancellation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        [mockMercariSearch, mockYahooSearch, mockPaypaySearch, mockFrilSearch, mockSurugayaSearch, mockTaobaoSearch, mockGoofishSearch, mockMandarakeSearch]
            .forEach(search => search.mockResolvedValue([]));
    });

    test('routes Mercari and Yahoo through HTTP while retaining browser limits for Taobao and Goofish', async () => {
        await searchAggregator.searchAll('kit', enabledBrowserAndHttpSites, true);

        expect(mockHttpPoolRun).toHaveBeenCalledTimes(2);
        expect(mockBrowserPoolRun).toHaveBeenCalledTimes(2);
        expect(mockMercariSearch).toHaveBeenCalledTimes(1);
        expect(mockYahooSearch).toHaveBeenCalledTimes(1);
        expect(mockTaobaoSearch).toHaveBeenCalledTimes(1);
        expect(mockGoofishSearch).toHaveBeenCalledTimes(1);
    });

    test('does not emit a terminal scraper result after the search is aborted', async () => {
        let finishMercari;
        mockMercariSearch.mockImplementation(() => new Promise(resolve => { finishMercari = resolve; }));
        const onProgress = jest.fn();
        const abortController = new AbortController();
        const search = searchAggregator.searchAll('kit', {
            ...enabledBrowserAndHttpSites,
            yahoo: false,
            taobao: false,
            goofish: false
        }, true, [], onProgress, {}, abortController.signal);

        await Promise.resolve();
        await Promise.resolve();
        expect(mockMercariSearch).toHaveBeenCalledWith('kit', true, [], expect.any(Function), abortController.signal);
        abortController.abort();

        await expect(search).rejects.toMatchObject({ code: 'ABORT_ERR' });
        finishMercari([]);
        await Promise.resolve();
        await Promise.resolve();

        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', source: 'Mercari' }));
        expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'result',
            source: 'Mercari',
            partial: false
        }));
    });
});
