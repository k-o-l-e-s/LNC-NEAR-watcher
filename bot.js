const dotenv 	= require('dotenv').config()
const Telegraf	= require('telegraf') 				// telegram bot api 
const bot 		= new Telegraf(process.env.BOT_TOKEN) 
const nearApi 	= require('near-api-js') 			// near api
const level  	= require('level') 					// on-disk key-value store
const accounts	= level('./accounts')
const users		= level('./users')
const network 	= 'mainnet'
const config 	= {networkId:'mainnet',nodeUrl:'https://rpc.'+network+'.near.org',walletUrl:'https://wallet.'+network+'.near.org',helperUrl:'https://helper.'+network+'.near.org',explorerUrl:'https://explorer.'+network+'.near.org'}
const admins 	= [1234567890]
const options 	= {}
let postslist 	= []

// wallets list
getAccounts	= function (prefix, full){
    return new Promise(resolve => {
        const list = []
		const options = prefix?{keys:true, values:true, gt:prefix, lte:prefix+'\uFFFF'}:{keys:true, values:true}
        accounts.createReadStream(options)
        .on('data' ,data => list.push(prefix && !full?data.value:{key:data.key,value:data.value}))
        .on('error',err  => resolve({err:err}))
        .on('close',() => resolve(list))
    })
}

// users list
getUsers = function (){
    return new Promise(resolve => {
        const list = []
        users.createReadStream({values:true})
        .on('data' ,data => list.push(data.value))
        .on('error',err  => resolve({err:err}))
        .on('close',() => resolve(list))
    })
}

// fetching transactions of last blocks
fetchTransactions = async (accountId) => {
	if (options.busy) return
	options.busy = 1
	try{
		const keyStore = new nearApi.keyStores.InMemoryKeyStore()
		const near = await nearApi.connect({deps:{keyStore},...config})
		const blockDetails = [], d = Date.now()
		let blockHash
		for (let k=0;k<300;k++){
			const currentBlock = await near.connection.provider.block(blockHash?{blockId:blockHash}:{finality:'final'})
			if (!options.last_block) options.last_block = currentBlock.header.prev_hash
			else if (options.last_block === currentBlock.header.hash) break
			blockDetails.push(currentBlock)
			blockHash = currentBlock.header.prev_hash
		}
		if (blockDetails[0]) options.last_block = blockDetails[0].header.hash
		const chunkHashArr = blockDetails.flatMap((block) => block.chunks.map(({chunk_hash}) => chunk_hash))
		const chunkDetails = await Promise.all(chunkHashArr.map((chunk) => {return near.connection.provider.chunk(chunk)}))
		const transactions = chunkDetails.flatMap(chunk => (chunk.transactions || [])).map(e => ({sender:e.signer_id,receiver:e.receiver_id,hash:e.hash,value:e.actions && e.actions[0] && e.actions[0].Transfer && e.actions[0].Transfer.deposit,args:e.actions && e.actions[0] && e.actions[0].FunctionCall && e.actions[0].FunctionCall.args && Buffer.from(e.actions[0].FunctionCall.args,'base64').toString().toLowerCase()}))

		let list = await getAccounts()
		list = list.err?[]:list.map(e => {
			const values = e.value.split(' ')
			return {user:e.key.split('.')[0], wallet:values[0], min:values[1]?+values[1]:0}
		})
		list.forEach(e => {
			let matches = transactions.filter(k => k.sender === e.wallet || k.receiver === e.wallet || (k.args && (e.wallet.indexOf('.')>0?k.args.indexOf('"'+e.wallet.toLowerCase()+'"')>0:k.args.indexOf(e.wallet.toLowerCase())>0)))
			if (e.min) matches = matches.filter(k => k.value && +(nearApi.utils.format.formatNearAmount(k.value)).replace(/\,/g,'') >= e.min)
			if (matches.length) 
				for (const m of matches) postslist.push({...e,...m})
		})
		if (Date.now()-d > 10000) console.log(blockDetails.length+' txs, '+(Date.now()-d)+'ms')
	}catch(err){}
	options.busy = 0
}
setInterval(fetchTransactions,5000) // fetch transactions each 5 seconds

// sending alert posts 
showWallet = (wallet) => /^[0-9a-f]{64}$/.exec(wallet)?wallet.substr(0,5)+'...'+wallet.substr(-10):wallet
checkPosts = async () => {
	const ready = {}
	for (let i=0;i<postslist.length;i++){
		const id = postslist[i].user
		if (!ready['id'+id]) ready['id'+id] = ''
		if (!postslist[i].text){
			let text = 'Tx <a href="https://explorer.near.org/transactions/'+postslist[i].hash+'">'+postslist[i].hash.substr(0,7)+'...'+postslist[i].hash.substr(-4)+'</a>\n'
			text += '<code>signed by </code><a href="https://explorer.near.org/accounts/'+postslist[i].sender+'">'+(postslist[i].sender===postslist[i].wallet?'<b>'+showWallet(postslist[i].sender)+'</b>':showWallet(postslist[i].sender))+'</a>\n'
			text += '<code>receiver  </code><a href="https://explorer.near.org/accounts/'+postslist[i].receiver+'">'+(postslist[i].receiver===postslist[i].wallet?'<b>'+showWallet(postslist[i].receiver)+'</b>':showWallet(postslist[i].receiver))+'</a>\n'
			if (postslist[i].value) text += '<b>'+nearApi.utils.format.formatNearAmount(postslist[i].value)+' NEAR</b>\n'
			text += '\n'
			ready['id'+id] += text
		} else ready['id'+id] += postslist[i].text
	}
	postslist = Object.keys(ready).map(key => ({user:+key.substr(2),text:ready[key]}))
	let i=0
	while (postslist.length){
		if (++i >= 25) break
		const x = postslist.shift()
		bot.telegram.sendMessage(x.user,x.text,{parse_mode:'HTML'}).catch(async err => {
			if (err.code == 403){
				const list = await getAccounts(x.user+'.',1)
				if (!list.err){
					console.log(list.length+' wallets of '+x.user+' are deleted')
					await accounts.batch(list.map(e => ({type:'del',key:e.key})))
				}	
			}
		})
	}
	if (postslist.length) bot.telegram.sendMessage(admins[0],'not send: '+postslist.length).catch(err => console.log(err))
}
setInterval(checkPosts,1000) // check alert posts each second

// collect bot users
bot.use(async (ctx,next) => {
	if (ctx.from && ctx.from.id) {
		try{
			await users.get(ctx.from.id)	
		}catch(err){
			await users.put(ctx.from.id,JSON.stringify({...ctx.from, date:Math.ceil(Date.now()/1000)}))	
		}
		return next()
	}
})
// removing wallet from user list
offAccount = async (ctx) => {
	try{
		await accounts.get(ctx.from.id+'.'+ctx.match[1])
		await accounts.del(ctx.from.id+'.'+ctx.match[1])
	}catch(err){
		return ctx.reply('Account not found')
	}
	const list = await getAccounts(ctx.from.id+'.')
	if (list.err) return ctx.reply('Account access error')
	return ctx.reply('Account <code>'+ctx.match[1]+'</code> deleted\n\n<code>'+list.join('</code>\n<code>')+'</code>',{parse_mode:'HTML'})
}
bot.hears(/^\/*off\s*(\S+?\.near)$/i, ctx => offAccount(ctx))
bot.hears(/^\/*off\s*([0-9a-f]{64})$/i, ctx => offAccount(ctx))
bot.start(ctx => ctx.reply('Send an account name and the bot will notify you of new transactions\n\n/\list - list of accounts\n\nTo disable tracking send command "<b>off account_name</b>"',{parse_mode:'HTML'}))
// bot statistic
bot.command('stat', async (ctx,next) => {
	if (admins.indexOf(ctx.from.id)<0) return next()
	const accountsList = await getAccounts()
	const usersList = await getUsers()
	return ctx.reply('Accounts: '+accountsList.length+'\nUsers: '+usersList.length,{parse_mode:'HTML'}) 
})
// bot users list
bot.command('users', async ctx => {
	if (admins.indexOf(ctx.from.id)<0) return next()	
	const usersList = await getUsers()
	if (usersList.err) return ctx.reply(list.err)
	let text = ''
	for (const user of usersList){
		const userValues = JSON.parse(user)
		const wallets = await getAccounts(userValues.id+'.')
		text += user+'\n'+(wallets.err?wallets.err:wallets.join('\n'))+'\n\n'
	}
	bot.telegram.sendDocument(ctx.from.id,{source:Buffer.from(text),filename:'nearwatchbot.txt'},{caption:usersList.length+' users'})
})
// user wallets list
bot.command('list', async ctx => {
	const list = await getAccounts(ctx.from.id+'.')
	return ctx.reply(list.err?'Account access error':'Accounts:\n<code>'+list.join('</code>\n<code>')+'</code>',{parse_mode:'HTML'})
})
// adding wallet 
bot.on('message', async ctx => {
	const data = /^([a-z0-9-_\.]{1,59}\.near)\s*(\d{1,6})*$/i.exec(ctx.message.text) || /^([0-9a-f]{64})\s*(\d{1,6})*$/i.exec(ctx.message.text)
	if (!data) return ctx.reply('Wrong near account name')
	data[1] = data[1].toLowerCase()
	let list = await getAccounts(ctx.from.id+'.')
	if (list.err) return ctx.reply('Account access error')
	if (list.length>19) return ctx.reply('20 accounts allowed per user')
	let text = 'Account <code>'+data[1]+'</code> added for tracking '+(data[2]?'(greater '+data[2]+' near)':'')+'\n\n'
    await accounts.put(ctx.from.id+'.'+data[1],data[1]+(data[2]?' '+data[2]:''))
	list = await getAccounts(ctx.from.id+'.')
	text += '<code>'+list.join('</code>\n<code>')+'</code>'
	return ctx.reply(text,{parse_mode:'HTML'})
})
bot.catch(err => console.error(err))
bot.launch()
bot.telegram.getMe().then(res=>console.log(res))
