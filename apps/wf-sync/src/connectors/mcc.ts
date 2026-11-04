/**
 * Merchant category codes as ordinary Wealthfolio spending rules.
 *
 * Wealthfolio's rules read an activity's note and can't see its metadata, so a connector
 * ends each note with mccTag(). Being rules, they can be seen and changed in Settings, and
 * a rule written by hand outranks them.
 *
 * Money moves (4829 transfers, 6010/6011 cash, 6012 banks, 6051 and 6538/6540 funding) stay
 * uncategorized: the code says nothing about what the money bought.
 */

import type { SpendingRule } from '../models.ts';

const CODES: Record<string, string> = {
	cat_groceries: '5411 5422 5441 5451 5462 5499',
	cat_food_restaurants: '5811 5812 5814',
	cat_food_alcohol: '5813 5921',
	cat_transport: '4784 4789',
	cat_transport_gas: '5172 5541 5542 5983',
	cat_transport_parking: '7523',
	cat_transport_public: '4111 4112 4131',
	cat_transport_rideshare: '4121',
	cat_transport_maintenance: '5511 5521 5531 5532 5533 5571 5599 7531 7534 7535 7538 7542 7549',
	cat_shopping: '5300 5309 5310 5311 5331 5399 5941 5943 5944 5945 5948 5949 5950 5970',
	cat_shopping_clothing:
		'5137 5611 5621 5631 5641 5651 5655 5661 5681 5691 5697 5698 5699 5931 7296',
	cat_shopping_electronics: '5045 5732 5946',
	cat_shopping_home: '5200 5211 5231 5251 5261 5712 5713 5714 5718 5719 5722',
	cat_shopping_online: '4215 5262 5964 5965 5966 5969',
	cat_entertainment: '7911 7922 7929 7932 7933 7991 7995 7996 7998 7999',
	cat_entertainment_streaming: '4899 5815',
	cat_entertainment_movies: '7829 7832 7833 7841',
	cat_entertainment_games: '5816 7993 7994',
	cat_entertainment_hobbies: '5733 5735',
	cat_entertainment_sports: '7941 7992',
	cat_health_medical: '4119 5047 8011 8031 8041 8049 8050 8062 8071 8099',
	cat_health_pharmacy: '5122 5912',
	cat_health_dental: '8021',
	cat_health_vision: '8042 8043',
	cat_health_fitness: '7997',
	cat_bills_phone: '4812 4814',
	cat_bills_internet: '4816',
	cat_bills_subscriptions: '2741 5192 5968',
	cat_bills_software: '5734 5817 5818 7371 7372 7379',
	cat_housing_rent: '6513',
	cat_housing_utilities: '4900',
	cat_housing_maintenance: '1520 1711 1731 1740 1750 1761 1771 1799',
	cat_personal: '5977 7210 7211 7216 7230 7251 7297 7298',
	cat_education: '5942 8211 8220 8241 8244 8249 8299',
	cat_travel: '3\\d{3} 4411 4511 4582 4722 7011 7012 7033 7512 7519',
	cat_gifts: '5947 8398 8641 8661',
	cat_other_expense: '5992 5993 5994 5995 5999 7277 8999',
	cat_fees: '9222 9223 9311 9399 9402',
};

export const mccTag = (mcc: number) => `[mcc ${mcc}]`;

export const MCC_RULES: SpendingRule[] = Object.entries(CODES).map(([categoryId, codes]) => ({
	id: `wfsync:mcc:${categoryId}`,
	name: `MCC: ${categoryId.replace(/^cat_/, '').replaceAll('_', ' ')}`,
	pattern: `\\[mcc (${codes.replaceAll(' ', '|')})\\]$`,
	categoryId,
}));
