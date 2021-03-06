// modules build-in
const path = require('path');
const fs = require('fs');

// package json
const packageJson = require(path.join(__dirname,'package.json'));

// program name
console.log(`\n=== Funimation Downloader NX ${packageJson.version} ===\n`);
const api_host = `https://prod-api-funimationnow.dadcdigital.com/api`;

// modules extra
const yaml = require('yaml');
const shlp = require('sei-helper');
const yargs = require('yargs');
const request = require('request');
const agent = require('socks5-https-client/lib/Agent');
const { ttml2srt } = require('ttml2srt');

// m3u8
const m3u8 = require('m3u8-parsed');
const streamdl = require('hls-download');

// config
const configFile = path.join(__dirname,'/modules/config.main.yml');
const tokenFile = path.join(__dirname,'/modules/config.token.yml');

// params
let cfg = {};
let token = false;

if(!fs.existsSync(configFile)){
    console.log(`[ERROR] config file not found!`);
    process.exit();
}
else{
    cfg = yaml.parse(
        fs.readFileSync(configFile, 'utf8')
            .replace(/\${__dirname}/g,__dirname.replace(/\\/g,'/'))
    );
}

if(fs.existsSync(tokenFile)){
    token = yaml.parse(fs.readFileSync(tokenFile, 'utf8')).token;
    console.log(`[INFO] Token: %s%s\n`, token.slice(0,8),'*'.repeat(32));
}
else{
    console.log(`[INFO] Token not set!\n`);
}

// cli
let argv = yargs
    .wrap(Math.min(100))
    .usage('Usage: $0 [options]')
    .help(false).version(false)
    
    // login
    .describe('user','Your username or email')
    .describe('pass','Your password')
    
    // search
    .describe('search','Sets the show title for search')
    
    // params
    .describe('s','Sets the show id')
    .describe('e','Select episode ids (comma-separated, hyphen-sequence)')
    
    .describe('q','Video layer (0 is max)')
    .choices('q', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    .default('q', cfg.cli.videoLayer)
    
    .describe('alt','Alternative episode listing (if available)')
    .boolean('alt')
    
    .describe('sub','Subtitles mode (Dub mode by default)')
    .boolean('sub')
    
    .describe('simul','Forсe download simulcast version instead of uncut')
    .boolean('simul')
    
    .describe('x','Select server (1 is cloudfront.net, 2...3 is dlvr1.net)')
    .choices('x', [1, 2, 3])
    .default('x', cfg.cli.nServer)
    
    .describe('nosubs','Skip download subtitles for Dub (if available)')
    .boolean('nosubs')
    
    // proxy
    .describe('socks','Set ipv4 socks5 proxy')
    .describe('socks-login','Set socks5 username')
    .describe('socks-pass','Set socks5 password')
    .describe('proxy','Set ipv4 http(s) proxy')
    .describe('ssp','Don\'t use proxy for stream downloading')
    .boolean('ssp')
    
    .describe('mp4','Mux into mp4')
    .boolean('mp4')
    .default('mp4',cfg.cli.mp4mux)
    .describe('mks','Add subtitles to mkv or mp4 (if available)')
    .boolean('mks')
    .default('mks',cfg.cli.muxSubs)
    
    .describe('a','Filenaming: Release group')
    .default('a',cfg.cli.releaseGroup)
    .describe('t','Filenaming: Series title override')
    .describe('ep','Filenaming: Episode number override (ignored in batch mode)')
    .describe('suffix','Filenaming: Filename suffix override (first "SIZEp" will be replaced with actual video size)')
    .default('suffix',cfg.cli.fileSuffix)
    
    // util
    .describe('nocleanup','move temporary files to trash folder instead of deleting')
    .boolean('nocleanup')
    .default('nocleanup',cfg.cli.noCleanUp)
    
    // help
    .describe('h','Show this help')
    .alias('h','help')
    .boolean('h')
    .version(false)
    
    .argv;

// check page
if(!isNaN(parseInt(argv.p, 10)) && parseInt(argv.p, 10) > 0){
    argv.p = parseInt(argv.p, 10);
}
else{
    argv.p = 1;
}

// fn variables
let fnTitle = '',
    fnEpNum = '',
    fnSuffix = '',
    fnOutput = '',
    tsDlPath = false,
    stDlPath = false,
    batchDL = false;

// go to work folder
try {
    fs.accessSync(cfg.dir.content, fs.R_OK | fs.W_OK)
} catch (e) {
    console.log(e);
    console.log(`[ERROR] %s`,e.messsage);
    process.exit();
}
process.chdir(cfg.dir.content);

// select mode
if(argv.user && argv.pass){
    auth();
}
else if(argv.search){
    searchShow();
}
else if(argv.s && !isNaN(parseInt(argv.s,10)) && parseInt(argv.s,10) > 0){
    getShow();
}
else{
    yargs.showHelp();
    process.exit();
}

// auth
async function auth(){
    let authData = await getData(`${api_host}/auth/login/`,false,true,false,true);
    if(checkRes(authData)){return;}
    authData = JSON.parse(authData.res.body);
    if(authData.token){
        console.log(`[INFO] Authentication success, your token: %s%s\n`, authData.token.slice(0,8),'*'.repeat(32));
        fs.writeFileSync(tokenFile,yaml.stringify({"token":authData.token}));
    }
    else{
        console.log(`[ERROR]`,authData.error,`\n`);
        process.exit(1);
    }
}

// search show
async function searchShow(){
    let qs = {unique:true,limit:100,q:argv.search,offset:(argv.p-1)*1000};
    let searchData = await getData(`${api_host}/source/funimation/search/auto/`,qs,true,true);
    if(checkRes(searchData)){return;}
    searchData = JSON.parse(searchData.res.body);
    if(searchData.items.hits){
        let shows = searchData.items.hits;
        console.log(`[INFO] Search Results:`);
        for(let ssn in shows){
            console.log(`[#${shows[ssn].id}] ${shows[ssn].title}` + (shows[ssn].tx_date?` (${shows[ssn].tx_date})`:``));
        }
    }
    console.log(`[INFO] Total shows found: %s\n`,searchData.count);
}

// get show
async function getShow(){
    // show main data
    let showData = await getData(`${api_host}/source/catalog/title/`+parseInt(argv.s,10),false,true,true);
    if(checkRes(showData)){return;}
    // check errors
    showData = JSON.parse(showData.res.body);
    if(showData.status){
        console.log(`[ERROR] Error #%d: %s\n`, showData.status, showData.data.errors[0].detail);
        process.exit(1);
    }
    else if(!showData.items || showData.items.length<1){
        console.log(`[ERROR] Show not found\n`);
    }
    showData = showData.items[0];
    console.log(`[#%s] %s (%s)`,showData.id,showData.title,showData.releaseYear);
    // show episodes
    let qs = {limit:-1,sort:'order',sort_direction:'ASC',title_id:parseInt(argv.s,10)};
    if(argv.alt){ qs.language = `English`; }
    let episodesData = await getData(`${api_host}/funimation/episodes/`,qs,true,true);
    if(checkRes(episodesData)){return;}
    let eps = JSON.parse(episodesData.res.body).items, fnSlug = [], is_selected = false;
    argv.e = typeof argv.e == 'number' || typeof argv.e == 'string' ? argv.e.toString() : '';
    argv.e = argv.e.match(',') ? argv.e.split(',') : [argv.e];
    let epSelList = argv.e, epSelRanges = [], epSelEps = [];
    epSelList = epSelList.map((e)=>{
        if(e.match('-')){
            e = e.split('-');
            if( e[0].match(/^(?:[A-Z]|)\d+$/i) && e[1].match(/^\d+$/) ){
                e[0] = e[0].replace(/^(?:([A-Z])|)(0+)/i,'$1');
                let letter = e[0].match(/^([A-Z])\d+$/i) ? e[0].match(/^([A-Z])\d+$/i)[1].toUpperCase() : '';
                e[0] = e[0].replace(/^[A-Z](\d+)$/i,'$1');
                e[0] = parseInt(e[0]);
                e[1] = parseInt(e[1]);
                if(e[0] < e[1]){
                    for(let i=e[0];i<e[1]+1;i++){
                        epSelRanges.push(letter+i);
                    }
                    return '';
                }
                else{
                    return (letter+e[0]);
                }
            }
            else{
                return '';
            }
        }
        else if(e.match(/^(?:[A-Z]|)\d+$/i)){
            return e.replace(/^(?:([A-Z])|)(0+)/i,'$1').toUpperCase();
        }
        else{
            return '';
        }
    });
    epSelList = [...new Set(epSelList.concat(epSelRanges))];
    // parse episodes list
    for(let e in eps){
        let showStrId = eps[e].ids.externalShowId;
        let epStrId = eps[e].ids.externalEpisodeId.replace(new RegExp('^'+showStrId),'');
        // select
        if(epSelList.includes(epStrId.replace(/^(?:([A-Z])|)(0+)/,'$1'))){
            fnSlug.push({title:eps[e].item.titleSlug,episode:eps[e].item.episodeSlug});
            epSelEps.push(epStrId);
            is_selected = true;
        }
        else{
            is_selected = false;
        }
        // console vars
        let tx_snum = eps[e].item.seasonNum==1?'':` S${eps[e].item.seasonNum}`;
        let tx_type = eps[e].mediaCategory != 'episode' ? eps[e].mediaCategory : ``;
        let tx_enum = eps[e].item.episodeNum !== '' ?
            `#${(eps[e].item.episodeNum < 10 ? '0' : '')+eps[e].item.episodeNum}` : `#`+eps[e].item.episodeId;
        let qua_str = eps[e].quality.height ? eps[e].quality.quality + eps[e].quality.height : `UNK`;
        let aud_str = eps[e].audio.length > 0 ? `, ${eps[e].audio.join(', ')}` : '';
        let rtm_str = eps[e].item.runtime !== '' ? eps[e].item.runtime : '??:??';
        // console string
        let episodeIdStr = epStrId;
        let conOut  = `[${episodeIdStr}] `;
            conOut += `${eps[e].item.titleName+tx_snum} - ${tx_type+tx_enum} ${eps[e].item.episodeName} `;
            conOut += `(${rtm_str}) [${qua_str+aud_str}]`;
            conOut += is_selected ? ' (selected)' : '';
            conOut += eps.length-1 == e ? '\n' : '';
        console.log(conOut);
    }
    if(fnSlug.length>1){
        batchDL = true;
    }
    if(fnSlug.length<1){
        console.log(`[INFO] Episodes not selected!\n`);
        process.exit();
    }
    else{
        console.log(`[INFO] Selected Episodes: %s\n`,epSelEps.join(', '));
        for(let fnEp=0;fnEp<fnSlug.length;fnEp++){
            await getEpisode(fnSlug[fnEp]);
        }
    }
}

async function getEpisode(fnSlug){
    let episodeData = await getData(`${api_host}/source/catalog/episode/${fnSlug.title}/${fnSlug.episode}/`,false,true,true);
    if(checkRes(episodeData)){return;}
    let ep = JSON.parse(episodeData.res.body).items[0], streamId = 0;
    // build fn
    fnTitle = argv.t ? argv.t : ep.parent.title;
    ep.number = isNaN(ep.number) ? ep.number : ( parseInt(ep.number, 10) < 10 ? '0' + ep.number : ep.number );
    if(ep.mediaCategory != 'Episode'){
        ep.number = ep.number !== '' ? ep.mediaCategory+ep.number : ep.mediaCategory+'#'+ep.id;
    }
    fnEpNum = argv.ep && !batchDL ? ( parseInt(argv.ep, 10) < 10 ? '0' + argv.ep : argv.ep ) : ep.number;
    // is uncut
    let uncut = {
        Japanese: false,
        English: false
    };
    // end
    console.log(
        `[INFO] %s - S%sE%s - %s`,
        ep.parent.title,
        (ep.parent.seasonNumber?ep.parent.seasonNumber:'?'),
        (ep.number?ep.number:'?'),
        ep.title
    );
    console.log(`[INFO] Available audio tracks:`);
    // map medias
    let media = ep.media.map(function(m){
        if(m.mediaType=='experience'){
            if(m.version.match(/uncut/i)){
                uncut[m.language] = true;
            }
            return { 
                id: m.id, 
                language: m.language,
                version: m.version,
                subtitles: getSubsUrl(m.mediaChildren)
            };
        }
        else{
            return { id: 0 };
        }
    });
    // select
    for(let m of media){
        let selected = false;
        if(m.id>0){
            let dub_type = m.language;
            let selUncut = !argv.simul && uncut[dub_type] && m.version.match(/uncut/i) ? true : (!uncut[dub_type] || argv.simul && m.version.match(/simulcast/i) ? true : false);
            if(dub_type == 'Japanese' && argv.sub && selUncut){
                streamId = m.id;
                stDlPath = m.subtitles;
                selected = true;
            }
            else if(dub_type == 'English' && !argv.sub && selUncut ){
                streamId = m.id;
                stDlPath = m.subtitles;
                selected = true;
            }
            console.log(`[#%s] %s [%s] %s`,m.id,dub_type,m.version,(selected?' (selected)':''));
        }
    }
    if(streamId<1){
        console.log(`[ERROR] Track not selected\n`);
        return;
    }
    else{
        let streamData = await getData(`${api_host}/source/catalog/video/${streamId}/signed`,{"dinstid":"uuid"},true,true);
        if(checkRes(streamData)){return;}
        streamData = JSON.parse(streamData.res.body);
        tsDlPath = false;
        if(streamData.errors){
            console.log(`[ERROR] Error #%s: %s\n`,streamData.errors[0].code,streamData.errors[0].detail);
            return;
        }
        else{
            for(let u in streamData.items){
                if(streamData.items[u].videoType == 'm3u8'){
                    tsDlPath = streamData.items[u].src;
                    break;
                }
            }
        }
        if(!tsDlPath){
            console.log(`[ERROR] Unknown error\n`);
            return;
        }
        else{
            await downloadStreams();
        }
    }
}

function getSubsUrl(m){
    if(argv.nosubs && !argv.sub){
        return false;
    }
    for(let i in m){
        let fpp = m[i].filePath.split('.');
        let fpe = fpp[fpp.length-1];
        if(fpe == 'dfxp'){ // dfxp, srt, vtt
            return m[i].filePath;
        }
    }
    return false;
}

async function downloadStreams(){
    
    // req playlist
    let plQualityReq = await getData(tsDlPath);
    if(checkRes(plQualityReq)){return;}
    let plQualityLinkList = m3u8(plQualityReq.res.body);
    
    // build
    let plQuality = {};
    let plQualityAlt = {};
    let plQualityStr = [];
    let pl_max = 1;
    
    for(let s of plQualityLinkList.playlists){
        let pl_layer = parseInt(s.uri.match(/_Layer(\d+)\.m3u8$/)[1]);
        pl_max = pl_max < pl_layer ? pl_layer : pl_max;
        let pl_BANDWIDTH = Math.round(s.attributes.BANDWIDTH/1024);
        let pl_quality = s.attributes.RESOLUTION.height+'p';
        let pl_url = s.uri;
        let dl_domain = pl_url.split('/')[2];
        if(typeof plQualityAlt[pl_layer] == 'undefined'){
            plQualityAlt[pl_layer] = [];
        }
        if(dl_domain.match(/.cloudfront.net$/)){
            plQualityStr.push(`${pl_layer}: ${pl_quality} (${pl_BANDWIDTH}KiB/s)`);
            plQuality[pl_layer] = { "q": pl_quality, "url": pl_url };
        }
        else{
            plQualityAlt[pl_layer].push({ "q": pl_quality, "url": pl_url });
        }
    }
    
    // select quality and server
    argv.x = argv.x - 1;
    argv.q = argv.q < 1 && argv.q > pl_max ? pl_max : argv.q;
    let maxServers = plQualityAlt[argv.q].length + 1;
    if(argv.x > 0){
        plQuality[argv.q] = argv.x > maxServers-1 ? plQualityAlt[argv.q][0] : plQualityAlt[argv.q][argv.x-1];
    }
    let vidUrl = plQuality[argv.q].url;
    
    if(plQuality[argv.q]){
        console.log(`[INFO] Selected layer: ${argv.q}\n\tAvailable qualities:\n\t\t${plQualityStr.join('\n\t\t')}`);
        fnSuffix = argv.suffix.replace('SIZEp',plQuality[argv.q].q);
        console.log(`[INFO] Selected server: ` + ( argv.x < 1 ? `1` : ( argv.x > maxServers-1 ? maxServers : argv.x+1 ) ) + ` / Total servers available: ` + maxServers );
        console.log(`[INFO] Stream URL:`,vidUrl);
        fnOutput = shlp.cleanupFilename(`[${argv.a}] ${fnTitle} - ${fnEpNum} [${fnSuffix}]`);
        console.log(`[INFO] Output filename: ${fnOutput}`);
    }
    else{
        console.log(`[INFO] Available qualities:`,plQualityStr.join('\n\t'));
        console.log(`[ERROR] Layer not selected\n`);
        return;
    }
    
    // download video
    let reqVid = await getData(vidUrl,false,true);
    if(checkRes(reqVid)){return;}
    
    let chunkList = m3u8(reqVid.res.body);
    chunkList.baseUrl = vidUrl.split('/').slice(0, -1).join('/')+'/';
    
    let proxy;
    if(argv.socks && !argv.ssp){
        proxy = { "host": argv.socks, "type": "socks" };
        if(argv['socks-login'] && argv['socks-pass']){
            proxy['socks-login'] = argv['socks-login'];
            proxy['socks-pass'] = argv['socks-pass'];
        }
    }
    else if(argv.proxy && !argv.ssp){
        proxy = { "host": argv.proxy, "type": "http" };
    }
    let dldata = await streamdl({
        fn: fnOutput,
        m3u8json: chunkList,
        baseurl: chunkList.baseUrl,
        proxy: (proxy?proxy:false)
    });
    if(!dldata.ok){
        console.log(`[ERROR] ${dldata.err}\n`);
        return;
    }
    else{
        console.log(`[INFO] Video downloaded!\n`);
    }
    
    // download subtitles
    if(stDlPath){
        console.log(`[INFO] Downloading subtitles...`);
        console.log(stDlPath);
        let subsSrc = await getData(stDlPath,false,true);
        if(!checkRes(subsSrc)){
            let srtData = ttml2srt(subsSrc.res.body);
            fs.writeFileSync(`${fnOutput}.srt`,srtData);
            console.log(`[INFO] Subtitles downloaded!`);
        }
        else{
            console.log(`[ERROR] Failed to download subtitles!`);
            argv.mks = false;
        }
    }
    
    // add subs
    let addSubs = argv.mks && stDlPath ? true : false;
    
    if( !argv.mp4 && !isFile(cfg.bin.mkvmerge) && !isFile(cfg.bin.mkvmerge+`.exe`) ){
        console.log(`\n[WARN] MKVMerge not found, skip using this...`);
        cfg.bin.mkvmerge = false;
    }
    if( !isFile(cfg.bin.ffmpeg) && !isFile(cfg.bin.ffmpeg+`.exe`) ){
        console.log((cfg.bin.mkvmerge?`\n`:``)+`[WARN] FFmpeg not found, skip using this...`);
        cfg.bin.ffmpeg = false;
    }
    
    // select muxer
    if(!argv.mp4 && cfg.bin.mkvmerge){
        // mux to mkv
        let mkvmux  = `-o "${fnOutput}.mkv" --disable-track-statistics-tags --engage no_variable_data `;
            mkvmux += `--track-name "0:${argv.a}" --language "1:${argv.sub?'jpn':'eng'}" --video-tracks 0 --audio-tracks 1 --no-subtitles --no-attachments `;
            mkvmux += `"${fnOutput}.ts" `;
            mkvmux += addSubs ? `--language 0:eng "${fnOutput}.srt" ` : ``;
        shlp.exec(`mkvmerge`,`"${cfg.bin.mkvmerge}"`,mkvmux);
    }
    else if(cfg.bin.ffmpeg){
        let ffext = !argv.mp4 ? `mkv` : `mp4`;
        let ffmux = `-i "${fnOutput}.ts" `
            ffmux += addSubs ? `-i "${fnOutput}.srt" ` : ``;
            ffmux += `-map 0 -c:v copy -c:a copy `
            ffmux += addSubs ? `-map 1 ` : ``;
            ffmux += addSubs && !argv.mp4 ? `-c:s srt ` : ``;
            ffmux += addSubs &&  argv.mp4 ? `-c:s mov_text ` : ``;
            ffmux += `-metadata encoding_tool="no_variable_data" `;
            ffmux += `-metadata:s:v:0 title="[${argv.a}]" -metadata:s:a:0 language=${argv.sub?'jpn':'eng'} `;
            ffmux += addSubs ? `-metadata:s:s:0 language=eng ` : ``;
            ffmux += `"${fnOutput}.${ffext}"`;
        // mux to mkv
        shlp.exec(`ffmpeg`,`"${cfg.bin.ffmpeg}"`,ffmux);
    }
    else{
        console.log(`\n[INFO] Done!\n`);
        return;
    }
    if(argv.nocleanup){
        fs.renameSync(fnOutput+`.ts`, path.join(cfg.dir.trash,`/${fnOutput}.ts`));
        if(stDlPath && argv.mks){
            fs.renameSync(fnOutput+`.srt`, path.join(cfg.dir.trash,`/${fnOutput}.srt`));
        }
    }
    else{
        fs.unlinkSync(fnOutput+`.ts`, path.join(cfg.dir.trash,`/${fnOutput}.ts`));
        if(stDlPath && argv.mks){
            fs.unlinkSync(fnOutput+`.srt`, path.join(cfg.dir.trash,`/${fnOutput}.srt`));
        }
    }
    console.log(`\n[INFO] Done!\n`);
}

function isFile(file){
    try{
        const isFile = fs.statSync(file).isFile();
        return isFile;
    }
    catch(e){
        return false;
    }
}

function checkRes(r){
    if(r.err){
        console.log(`[ERROR] Error: %s`,r.err);
        if(r.res && r.res.body){
            console.log(`[ERROR] Body:\n%s\n`,r.res.body);
        }
        else{
            console.log(`[ERROR] Additional info:\n%s\n`,JSON.stringify(r.res,null,'\t'));
        }
        return true;
    }
    if(r.res && r.res.body && r.res.body.match(/^<!doctype/i) || r.res && r.res.body && r.res.body.match(/<html/)){
        console.log(`[ERROR] Error: %s, body:\n%s\n`,(r.err?r.err:r.res.statusCode),r.res.body);
        return true;
    }
    return false;
}

function log(data){
    console.log(JSON.stringify(data,null,'\t'));
}

// get data from url
function getData(url,qs,proxy,useToken,auth){
    let options = {};
    // request parameters
    options.url = url;
    if(qs){
        options.qs = qs;
    }
    if(auth){
        options.method = 'POST';
        options.formData = {
            username: argv.user,
            password: argv.pass
        };
    }
    if(useToken && token){
        options.headers = {
            Authorization: `Token ${token}`
        };
    }
    if(options.qs && options.qs.dinstid){
        if(!options.headers){
            options.headers = {};
        }
        options.headers.devicetype = 'Android Phone';
        delete options.qs;
    }
    if(proxy && argv.socks){
        options.agentClass = agent;
        let agentOptions = {
            socksHost: argv.socks.split(':')[0],
            socksPort: argv.socks.split(':')[1]
        };
        if(argv['socks-login'] && argv['socks-pass']){
            agentOptions.socksUsername = argv['socks-login'];
            agentOptions.socksPassword = argv['socks-pass'];
        }
        options.agentOptions = agentOptions;
        options.timeout = 10000;
    }
    else if(proxy && argv.proxy){
        options.proxy = 'http://'+argv.proxy;
        options.timeout = 10000;
    }
    // do request
    return new Promise((resolve) => {
        request(options, (err, res) => {
            if (err){
                res = err;
                resolve({ "err": "0", res });
            }
            if(auth && res.statusCode == 401){
                resolve({res});
            }
            if (res.statusCode != 200 && res.statusCode != 403) {
                resolve({ "err": res.statusCode, res });
            }
            resolve({res});
        });
    });
}
