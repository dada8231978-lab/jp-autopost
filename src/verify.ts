import { loadConfig } from './config.js';
import { ButtondownClient } from './buttondown.js';
import { formatPrice, netAfterStripe } from './publisher.js';

/** Buttondown's paid-subscriptions add-on, in cents per month. */
const BUTTONDOWN_ADDON_CENTS = 900;

/**
 * Pre-flight check: confirm the Buttondown connection and print the actual
 * economics at the configured price. Sends nothing and creates nothing.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ButtondownClient(config);
  const currency = config.SUBSCRIPTION_CURRENCY;
  const price = config.SUBSCRIPTION_PRICE_CENTS;

  const { username, subscribers } = await client.verify();
  console.log('Connected to Buttondown');
  console.log(`  newsletter  : ${username}`);
  console.log(`  subscribers : ${subscribers}`);

  const paid = await client.countPaidSubscribers();
  if (paid === null) {
    console.log('  paid        : (paid subscriptions add-on not enabled yet)');
  } else {
    console.log(`  paid        : ${paid}`);
  }

  const net = netAfterStripe(price);
  const feeRate = ((price - net) / price) * 100;

  console.log(`\nEconomics at ${formatPrice(price, currency)}/month`);
  console.log(
    `  net per member : ${formatPrice(Math.round(net), currency)} ` +
      `(${feeRate.toFixed(1)}% to Stripe; Buttondown takes 0%)`,
  );
  console.log(
    `  break-even     : ${Math.ceil(BUTTONDOWN_ADDON_CENTS / net)} paid members ` +
      `covers the ${formatPrice(BUTTONDOWN_ADDON_CENTS, currency)}/month add-on`,
  );
  console.log(
    `  $1,000/month   : ${Math.ceil((100000 + BUTTONDOWN_ADDON_CENTS) / net)} paid members`,
  );

  if (paid !== null) {
    const revenue = Math.round(paid * net) - BUTTONDOWN_ADDON_CENTS;
    console.log(
      `  current        : ${formatPrice(revenue, currency)}/month net ` +
        `(${paid} paid members, add-on deducted)`,
    );
  }

  console.log('\nPosting settings');
  console.log(`  status   : ${config.BUTTONDOWN_EMAIL_STATUS}`);
  console.log(`  audience : ${config.BUTTONDOWN_EMAIL_TYPE}`);
  if (config.BUTTONDOWN_EMAIL_STATUS === 'draft') {
    console.log('  -> Articles are saved as drafts. Nothing is sent until you press send.');
    console.log('     Set BUTTONDOWN_EMAIL_STATUS=about_to_send to publish automatically.');
  }

  console.log(
    '\nReminder: the subscription price itself is set in Buttondown ->\n' +
      'Settings -> Paid subscriptions, not by this tool. Make sure it matches\n' +
      `SUBSCRIPTION_PRICE_CENTS (${formatPrice(price, currency)}).`,
  );
}

main().catch((error: unknown) => {
  console.error('\n[FAILED]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
