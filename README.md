# LNC-NEAR-watcher

Simple bot to get notified about TXs on NEAR mainnet. 

The bot watch near transactions and send alert posts if the user adds a wallet address into checklist and the address equal signer or receiver address of transaction 

Add bot token to .env file

type for install and run 
npm i
node bot.js

You can type to the bot a wallet address like "7747991786f445efb658b69857eadc7a57b6b475beec26ed14da8bc35bb2b5b6" or "learn.near"
and bot added this wallet for the monitoring

If you want to see only transactions with volume more than 100 Near for example, send to the bot address and volume as 2th parameter
"learn.near 100"

For remove a wallet address from checklist send to the bot 
"off learn.near"
