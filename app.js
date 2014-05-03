//
// Copyright (c) 2011 Mashery, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// 'Software'), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

//
// Module dependencies
//
var express     = require('express'),
    util        = require('util'),
    fs          = require('fs'),
    path        = require('path'),
    OAuth       = require('oauth').OAuth,
    OAuth2      = require('oauth/lib/oauth2').OAuth2,
    query       = require('querystring'),
    url         = require('url'),
    http        = require('http'),
    https       = require('https'),
    crypto      = require('crypto'),
    clone       = require('clone'),
    redis       = require('redis'),
    pathy       = require('path'),
    RedisStore  = require('connect-redis')(express);

// Add minify to the JSON object
JSON.minify = JSON.minify || require("node-json-minify");

// Parse arguments
var yargs = require('yargs')
        .usage('Usage: $0 --config-file [file]')
        .alias('c', 'config-file')
        .alias('h', 'help')
        .describe('c', 'Specify the config file location')
        .default('c', './config.json');
var argv = yargs.argv;

if (argv.help) {
    yargs.showHelp();
    process.exit(0);
}

// Configuration
var configFilePath = path.resolve(argv['config-file']);
try {
    var config = JSON.parse(JSON.minify(fs.readFileSync(configFilePath, 'utf8')));

} catch(e) {
    console.error("File " + configFilePath + " not found or is invalid.  Try: `cp config.json.sample config.json`");
    process.exit(1);
}

//
// Redis connection
//
var defaultDB = '0';
if(config.redis) {
config.redis.database = config.redis.database || defaultDB;

if (process.env.REDISTOGO_URL || process.env.REDIS_URL) {
    var rtg   = require("url").parse(process.env.REDISTOGO_URL || process.env.REDIS_URL);
    config.redis.host = rtg.hostname;
    config.redis.port = rtg.port;
    config.redis.password = rtg.auth && rtg.auth.split(":")[1] ? rtg.auth.split(":")[1] : '';
}

var db = redis.createClient(config.redis.port, config.redis.host);
db.auth(config.redis.password);

db.on("error", function(err) {
    if (config.debug) {
         console.log("Error " + err);
    }
});
}

//
// Load API Configs
//

config.apiConfigDir = path.resolve(config.apiConfigDir || 'public/data');
if (!fs.existsSync(config.apiConfigDir)) {
    console.error("Could not find API config directory: " + config.apiConfigDir);
    process.exit(1);
}

try {
    var apisConfig = JSON.parse(JSON.minify(fs.readFileSync(path.join(config.apiConfigDir, 'apiconfig.json'), 'utf8')));
    if (config.debug) {
        console.log(util.inspect(apisConfig));
    }
} catch(e) {
    console.error("File apiconfig.json not found or is invalid.");
    process.exit(1);
}

//
// Determine if we should launch as http/s and get keys and certs if needed
//

var app, httpsKey, httpsCert;

if (config.https && config.https.on && config.https.keyPath && config.https.certPath) {
    console.log("Starting secure server (https)");

    // try reading the key and cert files, die if that fails
    try {
        httpsKey = fs.readFileSync(config.https.keyPath);
    } 
    catch (err) {
        console.error("Failed to read https key", config.https.keyPath);
        console.log(err);
        process.exit(1);
    }
    try {
        httpsCert = fs.readFileSync(config.https.certPath);
    }
    catch (err) {
        console.error("Failed to read https cert", config.https.certPath);
        console.log(err);
        process.exit(1);
    }

    app = module.exports = express.createServer({
        key: httpsKey,
        cert: httpsCert        
    });

}
else if (config.https && config.https.on) {
    console.error("No key or certificate specified.");
    process.exit(1);
}
else {
    app = module.exports = express.createServer();
}

if (process.env.REDISTOGO_URL) {
    var rtg   = require("url").parse(process.env.REDISTOGO_URL);
    config.redis.host = rtg.hostname;
    config.redis.port = rtg.port;
    config.redis.password = rtg.auth.split(":")[1];
}

app.configure(function() {
    app.set('views', __dirname + '/views');
    app.set('view engine', 'jade');
    app.use(express.logger());
    app.use(express.bodyParser());
    app.use(express.methodOverride());
    app.use(express.cookieParser());
if(config.redis) {
    app.use(express.session({
        secret: config.sessionSecret,
        store:  new RedisStore({
            'host':   config.redis.host,
            'port':   config.redis.port,
            'pass':   config.redis.password,
            'db'  :   config.redis.database,
            'maxAge': 1209600000
        })
    }));
} else {
    app.use(express.session({
        secret: config.sessionSecret
    }));
} 

    // Global basic authentication on server (applied if configured)
    if (config.basicAuth && config.basicAuth.username && config.basicAuth.password) {
        app.use(express.basicAuth(function(user, pass, callback) {
            var result = (user === config.basicAuth.username && pass === config.basicAuth.password);
            callback(null /* error */, result);
        }));
    }

    app.use(checkPathForAPI);
    app.use(dynamicHelpers);
    app.use(app.router);
    app.use(express.static(__dirname + '/public'));
});

app.configure('development', function() {
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function() {
    app.use(express.errorHandler());
});

//
// Middleware
//
function oauth(req, res, next) {
    console.log('OAuth process started');
    var apiName = req.body.apiName,
        apiConfig = apisConfig[apiName];

    if (apiConfig.oauth) {
        var apiKey = req.body.apiKey || req.body.key,
            apiSecret = req.body.apiSecret || req.body.secret,
            refererURL = url.parse(req.headers.referer),
            callbackURL = refererURL.protocol + '//' + refererURL.host + '/authSuccess/' + apiName,
            oa = new OAuth(apiConfig.oauth.requestURL,
                           apiConfig.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.oauth.version,
                           callbackURL,
                           apiConfig.oauth.crypt);

        if (config.debug) {
            console.log('OAuth type: ' + apiConfig.oauth.type);
            console.log('Method security: ' + req.body.oauth);
            console.log('Session authed: ' + req.session[apiName]);
            console.log('apiKey: ' + apiKey);
            console.log('apiSecret: ' + apiSecret);
        }

        // Check if the API even uses OAuth, then if the method requires oauth, then if the session is not authed
        if (apiConfig.oauth.type == 'three-legged' && req.body.oauth == 'authrequired' && (!req.session[apiName] || !req.session[apiName].authed) ) {
            if (config.debug) {
                console.log('req.session: ' + util.inspect(req.session));
                console.log('headers: ' + util.inspect(req.headers));
                console.log(util.inspect(oa));
                console.log('sessionID: ' + util.inspect(req.sessionID));
            }

            oa.getOAuthRequestToken(function(err, oauthToken, oauthTokenSecret, results) {
                if (err) {
                    res.send("Error getting OAuth request token : " + util.inspect(err), 500);
                } else {
                    // Unique key using the sessionID and API name to store tokens and secrets
                    var key = req.sessionID + ':' + apiName;

                    db.set(key + ':apiKey', apiKey, redis.print);
                    db.set(key + ':apiSecret', apiSecret, redis.print);

                    db.set(key + ':requestToken', oauthToken, redis.print);
                    db.set(key + ':requestTokenSecret', oauthTokenSecret, redis.print);

                    // Set expiration to same as session
                    db.expire(key + ':apiKey', 1209600000);
                    db.expire(key + ':apiSecret', 1209600000);
                    db.expire(key + ':requestToken', 1209600000);
                    db.expire(key + ':requestTokenSecret', 1209600000);

                    res.send({'signin': apiConfig.oauth.signinURL + oauthToken });
                }
            });
        } else if (apiConfig.oauth.type == 'two-legged' && req.body.oauth == 'authrequired') {
            // Two legged stuff... for now nothing.
            next();
        } else {
            next();
        }
    } else {
        next();
    }

}

function oauth2(req, res, next){
    console.log('OAuth2 process started');
    var apiName = req.body.apiName,
        apiConfig = apisConfig[apiName];

    if (apiConfig.oauth2) {
        var apiKey = req.body.apiKey || req.body.key,
            apiSecret = req.body.apiSecret || req.body.secret,
            refererURL = url.parse(req.headers.referer),
            callbackURL = refererURL.protocol + '//' + refererURL.host + '/oauth2Success/' + apiName,
            key = req.sessionID + ':' + apiName,
            oa = new OAuth2(apiKey,
                           apiSecret,
                           apiConfig.oauth2.baseSite,
                           apiConfig.oauth2.authorizeURL,
                           apiConfig.oauth2.accessTokenURL);

        if (apiConfig.oauth2.tokenName) {
            oa.setAccessTokenName(apiConfig.oauth2.tokenName);
        }

        if (config.debug) {
            console.log('OAuth type: ' + apiConfig.oauth2.type);
            console.log('Method security: ' + req.body.oauth2);
            console.log('Session authed: ' + req.session[apiName]);
            console.log('apiKey: ' + apiKey);
            console.log('apiSecret: ' + apiSecret);
        }

        var redirectUrl;
        if (apiConfig.oauth2.type == 'authorization-code') {
            redirectUrl = oa.getAuthorizeUrl({redirect_uri : callbackURL, response_type : 'code'});

            db.set(key + ':apiKey', apiKey, redis.print);
            db.set(key + ':apiSecret', apiSecret, redis.print);
            db.set(key + ':baseURL', callbackURL, redis.print);

            // Set expiration to same as session
            db.expire(key + ':apiKey', 1209600000);
            db.expire(key + ':apiSecret', 1209600000);
            db.expire(key + ':baseURL', 1209600000);

            res.send({'signin': redirectUrl});
        }
        else if (apiConfig.oauth2.type == 'implicit') {
            oa._authorizeUrl = oa._accessTokenUrl;
            redirectUrl = oa.getAuthorizeUrl({redirect_uri : callbackURL, response_type : 'token'});

            db.set(key + ':apiKey', apiKey, redis.print);
            db.set(key + ':apiSecret', apiSecret, redis.print);
            db.set(key + ':baseURL', req.headers.referer, redis.print);

            // Set expiration to same as session
            db.expire(key + ':apiKey', 1209600000);
            db.expire(key + ':apiSecret', 1209600000);
            db.expire(key + ':baseURL', 1209600000);

            res.send({'implicit': redirectUrl});
        }
        else if (apiConfig.oauth2.type == 'client_credentials') {
            var accessURL = apiConfig.oauth2.baseSite + apiConfig.oauth2.accessTokenURL;
            var basic_cred = apiKey + ':' + apiSecret;
            var encoded_basic = new Buffer(basic_cred).toString('base64');
 
            var http_method = (apiConfig.oauth2.authorizationHeader == 'Y') ? "POST" : "GET";
            var header = (apiConfig.oauth2.authorizationHeader == 'Y') ? {'Authorization' : 'Basic ' + encoded_basic} : '';
            var fillerpost = query.stringify({grant_type : "client_credentials", client_id : apiKey, client_secret : apiSecret});

            db.set(key + ':apiKey', apiKey, redis.print);
            db.set(key + ':apiSecret', apiSecret, redis.print);
            db.set(key + ':baseURL', req.headers.referer, redis.print);

            // Set expiration to same as session
            db.expire(key + ':apiKey', 1209600000);
            db.expire(key + ':apiSecret', 1209600000);
            db.expire(key + ':baseURL', 1209600000);

            //client_credentials w/Authorization header
            oa._request(http_method, accessURL, header, 
                fillerpost,
                '', function(error, data, response) {
                if (error) {
                    res.send("Error getting OAuth access token : " + util.inspect(error), 500);
                }
                else {
                    var results;
                    try {
                        results = JSON.parse(data);
                    }
                    catch(e) {
                        results = query.parse(data)
                    }
                    var oauth2access_token = results["access_token"];
                    var oauth2refresh_token = results["refresh_token"];

                    if (config.debug) {
                        console.log('results: ' + util.inspect(results));
                    }
                    db.mset([key + ':access_token', oauth2access_token,
                            key + ':refresh_token', oauth2refresh_token
                    ], function(err, results2) {
                        db.set(key + ':accessToken', oauth2access_token, redis.print);
                        db.set(key + ':refreshToken', oauth2refresh_token, redis.print);
                        db.expire(key + ':accessToken', 1209600000);
                        db.expire(key + ':refreshToken', 1209600000);
                        
                        res.send({'refresh': callbackURL});
                    });
                }
            })
        }
    }
}


function oauth2Success(req, res, next) {
    console.log('oauth2Success started');
        var apiKey,
            apiSecret,
            apiName = req.params.api,
            apiConfig = apisConfig[apiName],
            key = req.sessionID + ':' + apiName,
            baseURL;

        if (config.debug) {
            console.log('apiName: ' + apiName);
            console.log('key: ' + key);
            console.log(util.inspect(req.params));
        }
        db.mget([
            key + ':apiKey',
            key + ':apiSecret',
            key + ':baseURL',
            key + ':accessToken',
            key + ':refreshToken'
        ], function(err, result) {
            if (err) {
                console.log(util.inspect(err));
            }
            apiKey = result[0];
            apiSecret = result[1];
            baseURL = result[2];

            if (result[3] && apiConfig.oauth2.type == 'client_credentials') {
                req.session[apiName] = {};
                req.session[apiName].authed = true;
                if (config.debug) {
                    console.log('session[apiName].authed: ' + util.inspect(req.session));
                }
                next();
            }

            if (config.debug) {
                console.log(util.inspect(">>"+req.query.oauth_verifier));
            }

            var oa = new OAuth2(apiKey,
                   apiSecret,
                   apiConfig.oauth2.baseSite,
                   apiConfig.oauth2.authorizeURL,
                   apiConfig.oauth2.accessTokenURL);

            if (apiConfig.oauth2.tokenName) {
                oa.setAccessTokenName(apiConfig.oauth2.tokenName);
            }

            if (config.debug) {
                console.log(util.inspect(oa));
            }

            if (apiConfig.oauth2.type == 'authorization-code') {
                oa.getOAuthAccessToken(req.query.code,
                    {grant_type : "authorization_code", redirect_uri : baseURL, client_id : apiKey, client_secret : apiSecret},
                    function(error, oauth2access_token, oauth2refresh_token, results){
                    if (error) {
                        res.send("Error getting OAuth access token : " + util.inspect(error) + "["+oauth2access_token+"]"+ "["+oauth2refresh_token+"]", 500);
                    } else {
                        if (config.debug) {
                            console.log('results: ' + util.inspect(results));
                        }
                        db.mset([key + ':access_token', oauth2access_token,
                                key + ':refresh_token', oauth2refresh_token
                        ], function(err, results2) {
                            req.session[apiName] = {};
                            req.session[apiName].authed = true;
                            if (config.debug) {
                                console.log('session[apiName].authed: ' + util.inspect(req.session));
                            }
                            next();
                        });
                    }
                });
            }
            else if (apiConfig.oauth2.type == 'implicit') {
                next();
            }
        });
}


//
// OAuth Success!
//
function oauthSuccess(req, res, next) {
    console.log('oauthSuccess started');
    var oauthRequestToken,
        oauthRequestTokenSecret,
        apiKey,
        apiSecret,
        apiName = req.params.api,
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName; // Unique key using the sessionID and API name to store tokens and secrets

    if (config.debug) {
        console.log('apiName: ' + apiName);
        console.log('key: ' + key);
        console.log(util.inspect(req.params));
    }

    db.mget([
        key + ':requestToken',
        key + ':requestTokenSecret',
        key + ':apiKey',
        key + ':apiSecret'
    ], function(err, result) {
        if (err) {
            console.log(util.inspect(err));
        }
        oauthRequestToken = result[0];
        oauthRequestTokenSecret = result[1];
        apiKey = result[2];
        apiSecret = result[3];

        if (config.debug) {
            console.log(util.inspect(">>"+oauthRequestToken));
            console.log(util.inspect(">>"+oauthRequestTokenSecret));
            console.log(util.inspect(">>"+req.query.oauth_verifier));
        }

        var oa = new OAuth(apiConfig.oauth.requestURL,
                           apiConfig.oauth.accessURL,
                           apiKey,
                           apiSecret,
                           apiConfig.oauth.version,
                           null,
                           apiConfig.oauth.crypt);


        if (config.debug) {
            console.log(util.inspect(oa));
        }

        oa.getOAuthAccessToken(oauthRequestToken, oauthRequestTokenSecret, req.query.oauth_verifier, function(error, oauthAccessToken, oauthAccessTokenSecret, results) {
            if (error) {
                res.send("Error getting OAuth access token : " + util.inspect(error) + "["+oauthAccessToken+"]"+ "["+oauthAccessTokenSecret+"]"+ "["+util.inspect(results)+"]", 500);
            } else {
                if (config.debug) {
                    console.log('results: ' + util.inspect(results));
                }
                db.mset([key + ':accessToken', oauthAccessToken,
                    key + ':accessTokenSecret', oauthAccessTokenSecret
                ], function(err, results2) {
                    req.session[apiName] = {};
                    req.session[apiName].authed = true;
                    if (config.debug) {
                        console.log('session[apiName].authed: ' + util.inspect(req.session));
                    }
                    next();
                });
            }
        });

    });
}


//
// processRequest - handles API call
//
function processRequest(req, res, next) {
    if (config.debug) {
        console.log(util.inspect(req.body, null, 3));
    }

    var reqQuery = req.body,
        customHeaders = {},
        params = reqQuery.params || {},
        content = reqQuery.requestContent || '',
        contentType = reqQuery.contentType || '',
        locations = reqQuery.locations || {},
        methodURL = reqQuery.methodUri,
        httpMethod = reqQuery.httpMethod,
        apiKey = reqQuery.apiKey,
        apiSecret = reqQuery.apiSecret,
        apiName = reqQuery.apiName,
        apiConfig = apisConfig[apiName],
        key = req.sessionID + ':' + apiName,
        implicitAccessToken = reqQuery.accessToken;

    for (var param in params) {
         if (params.hasOwnProperty(param)) {
             if (params[param] !== '') {
                 if (locations[param] == 'header') {
                     // Extract custom headers from the params
                     customHeaders[param] = params[param];
                     delete params[param];
                 } else {
                     // Replace placeholders in the methodURL with matching params
                     // URL params are prepended with ":"
                     var regx = new RegExp(':' + param);

                     // If the param is actually a part of the URL, put it in the URL and remove the param
                     if (!!regx.test(methodURL)) {
                         methodURL = methodURL.replace(regx, encodeURIComponent(params[param]));
                         delete params[param]
                     }
                 }
             } else {
                 delete params[param]; // Delete blank params
             }
         }
    }

    var baseHostInfo = apiConfig.baseURL.split(':');
    var baseHostUrl = baseHostInfo[0],
        baseHostPort = (baseHostInfo.length > 1) ? baseHostInfo[1] : "";
    var headers = {};
    for (var configHeader in apiConfig.headers) {
        if (apiConfig.headers.hasOwnProperty(configHeader)) {
            headers[configHeader] = apiConfig.headers[configHeader];
        }
    }
    for (var customHeader in customHeaders) {
        if (customHeaders.hasOwnProperty(customHeader)) {
            headers[customHeader] = customHeaders[customHeader];
        }
    }

    var paramString = query.stringify(params),
        privateReqURL = apiConfig.protocol + '://' + apiConfig.baseURL + apiConfig.privatePath + methodURL + ((paramString.length > 0) ? '?' + paramString : ""),
        options = {
            headers: clone(apiConfig.headers),
            protocol: apiConfig.protocol + ':',
            host: baseHostUrl,
            port: baseHostPort,
            method: httpMethod,
            path: apiConfig.publicPath + methodURL + ((paramString.length > 0) ? '?' + paramString : ""),
            rejectUnauthorized: false
        };

    if (apiConfig.oauth) {
        console.log('Using OAuth');

        // Three legged OAuth
        if (apiConfig.oauth.type == 'three-legged' && (reqQuery.oauth == 'authrequired' || (req.session[apiName] && req.session[apiName].authed))) {
            if (config.debug) {
                console.log('Three Legged OAuth');
            }

            db.mget([key + ':apiKey',
                     key + ':apiSecret',
                     key + ':accessToken',
                     key + ':accessTokenSecret'
                ],
                function(err, results) {

                    var apiKey = (typeof reqQuery.apiKey == "undefined" || reqQuery.apiKey == "undefined")?results[0]:reqQuery.apiKey,
                        apiSecret = (typeof reqQuery.apiSecret == "undefined" || reqQuery.apiSecret == "undefined")?results[1]:reqQuery.apiSecret,
                        accessToken = results[2],
                        accessTokenSecret = results[3];

                    var oa = new OAuth(apiConfig.oauth.requestURL || null,
                                       apiConfig.oauth.accessURL || null,
                                       apiKey || null,
                                       apiSecret || null,
                                       apiConfig.oauth.version || null,
                                       null,
                                       apiConfig.oauth.crypt);

                    if (config.debug) {
                        console.log('Access token: ' + accessToken);
                        console.log('Access token secret: ' + accessTokenSecret);
                        console.log('key: ' + key);
                    }

                    oa.getProtectedResource(privateReqURL, httpMethod, accessToken, accessTokenSecret,  function (error, data, response) {
                        req.call = privateReqURL;

                        if (error) {
                            console.log('Got error: ' + util.inspect(error));

                            if (error.data == 'Server Error' || error.data == '') {
                                req.result = 'Server Error';
                            } else {
                                req.result = error.data;
                            }

                            res.statusCode = error.statusCode;

                            next();
                        } else {
                            req.resultHeaders = response.headers;
                            req.result = JSON.parse(data);

                            next();
                        }
                    });
                }
            );
        } else if (apiConfig.oauth.type == 'two-legged' && reqQuery.oauth == 'authrequired') { // Two-legged
            if (config.debug) {
                console.log('Two Legged OAuth');
            }

            var body,
                oa = new OAuth(null,
                               null,
                               apiKey || null,
                               apiSecret || null,
                               apiConfig.oauth.version || null,
                               null,
                               apiConfig.oauth.crypt);

            var resource = options.protocol + '://' + options.host + options.path,
                cb = function(error, data, response) {
                    if (error) {
                        if (error.data == 'Server Error' || error.data == '') {
                            req.result = 'Server Error';
                        } else {
                            console.log(util.inspect(error));
                            body = error.data;
                        }

                        res.statusCode = error.statusCode;

                    } else {
                        var responseContentType = response.headers['content-type'];

                        if (/application\/javascript/.test(responseContentType)
                            || /text\/javascript/.test(responseContentType)
                            || /application\/json/.test(responseContentType)) {
                            body = JSON.parse(data);
                        }
                    }

                    // Set Headers and Call
                    if (response) {
                        req.resultHeaders = response.headers || 'None';
                    } else {
                        req.resultHeaders = req.resultHeaders || 'None';
                    }

                    req.call = url.parse(options.host + options.path);
                    req.call = url.format(req.call);

                    // Response body
                    req.result = body;
		    req.statusCode = response.statusCode;

                    next();
                };

            switch (httpMethod) {
                case 'GET':
                    console.log(resource);
                    oa.get(resource, '', '',cb);
                    break;
                case 'PUT':
                case 'POST':
                    oa.post(resource, '', '', JSON.stringify(obj), null, cb);
                    break;
                case 'DELETE':
                    oa.delete(resource,'','',cb);
                    break;
            }

        } else {
            // API uses OAuth, but this call doesn't require auth and the user isn't already authed, so just call it.
            unsecuredCall();
        }
    } else if (apiConfig.oauth2) {
        console.log('Using OAuth2');

        if (implicitAccessToken) {
            db.mset([key + ':access_token', implicitAccessToken
                    ], function(err, results2) {
                        req.session[apiName] = {};
                        req.session[apiName].authed = true;
                        if (config.debug) {
                            console.log('session[apiName].authed: ' + util.inspect(req.session));
                        }
                    });
        }

        if (reqQuery.oauth == 'authrequired' || (req.session[apiName] && req.session[apiName].authed)) {
            if (config.debug) {
                console.log('Session authed');
            }

            db.mget([key + ':apiKey',
                     key + ':apiSecret',
                     key + ':access_token',
                     key + ':refresh_token'
                ],
                function(err, results) {
                    var apiKey = (typeof reqQuery.apiKey == "undefined" || reqQuery.apiKey == "undefined")?results[0]:reqQuery.apiKey,
                        apiSecret = (typeof reqQuery.apiSecret == "undefined" || reqQuery.apiSecret == "undefined")?results[1]:reqQuery.apiSecret,
                        access_token = (implicitAccessToken) ? implicitAccessToken : results[2],
                        refresh_token = results[3];

                    var oa = new OAuth2(apiKey,
                           apiSecret,
                           apiConfig.oauth2.baseSite,
                           apiConfig.oauth2.authorizeURL,
                           apiConfig.oauth2.accessTokenURL);

                    if (apiConfig.oauth2.tokenName) {
                        oa.setAccessTokenName(apiConfig.oauth2.tokenName);
                    }

                    if (config.debug) {
                        console.log('Access token: ' + access_token);
                        console.log('Access token secret: ' + refresh_token);
                        console.log('key: ' + key);
                    }

                    if (apiConfig.oauth2.authorizationHeader && (apiConfig.oauth2.authorizationHeader == 'Y')) {
                        var headers = {Authorization : "Bearer " + access_token};
                    }

                    oa._request(httpMethod, privateReqURL, headers, requestBody, access_token, function (error, data, response) {
                        req.call = privateReqURL;

                        if (error) {
                            console.log('Got error: ' + util.inspect(error));

                            if (error.data == 'Server Error' || error.data == '') {
                                req.result = 'Server Error';
                            } else {
                                req.result = error.data;
                            }

                            res.statusCode = error.statusCode;

                            next();
                        } else {
                            req.resultHeaders = response.headers;
                            req.result = JSON.parse(data);
                            next();
                        }
                    });
                }
            );
        } else {
            // API uses OAuth, but this call doesn't require auth and the user isn't already authed, so just call it.
            unsecuredCall();
        }
    } else {
        // API does not use authentication
        unsecuredCall();
    }

    // Unsecured API Call helper
    function unsecuredCall() {
        console.log('Unsecured Call');

        // Add API Key to params, if any.
        if (apiKey != '' && apiKey != 'undefined' && apiKey != undefined) {
            if (options.path.indexOf('?') !== -1) {
                options.path += '&';
            }
            else {
                options.path += '?';
            }
            options.path += apiConfig.keyParam + '=' + apiKey;
        }

        // Perform signature routine, if any.
        if (apiConfig.signature) {
            var timeStamp, sig;
            if (apiConfig.signature.type == 'signed_md5') {
                // Add signature parameter
                timeStamp = Math.round(new Date().getTime()/1000);
                sig = crypto.createHash('md5').update('' + apiKey + apiSecret + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
            else if (apiConfig.signature.type == 'signed_sha256') { // sha256(key+secret+epoch)
                // Add signature parameter
                timeStamp = Math.round(new Date().getTime()/1000);
                sig = crypto.createHash('sha256').update('' + apiKey + apiSecret + timeStamp + '').digest(apiConfig.signature.digest);
                options.path += '&' + apiConfig.signature.sigParam + '=' + sig;
            }
        }

        // Setup headers, if any
        if (reqQuery.headerNames && reqQuery.headerNames.length > 0) {
            if (config.debug) {
                console.log('Setting headers');
            }
            var headers = {};

            for (var x = 0, len = reqQuery.headerNames.length; x < len; x++) {
                if (config.debug) {
                  console.log('Setting header: ' + reqQuery.headerNames[x] + ':' + reqQuery.headerValues[x]);
                }
                if (reqQuery.headerNames[x] != '') {
                    headers[reqQuery.headerNames[x]] = reqQuery.headerValues[x];
                }
            }

            options.headers = headers;
        }

        if(options.headers === void 0){
            options.headers = {}
        }
        if (!options.headers['Content-Length']) {
            if (content) {
                options.headers['Content-Length'] = content.length;
            }
            else {
                options.headers['Content-Length'] = 0;
            }
        }

        if (!options.headers['Content-Type'] && content) {
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        if (apiConfig.enableCookie) {
          if (config.debug) {
            console.log("enabled cookies")
          }
          options.headers['Cookie'] = req.headers.cookie;
        }

        if (config.debug) {
            console.log(util.inspect(options));
        }

        var doRequest;
        if (options.protocol === 'https' || options.protocol === 'https:') {
            console.log('Protocol: HTTPS');
            options.protocol = 'https:';
            doRequest = https.request;
        } else {
            console.log('Protocol: HTTP');
            doRequest = http.request;
        }
	if(contentType !== ''){
            if (config.debug) {
		console.log('Setting Content-Type: ' + contentType);
            }
	    options.headers['Content-Type'] = contentType;
	}

        // API Call. response is the response from the API, res is the response we will send back to the user.
        var apiCall = doRequest(options, function(response) {
            response.setEncoding('utf-8');

            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(response.headers));
                console.log('STATUS CODE: ' + response.statusCode);
            }

            res.statusCode = response.statusCode;

            var body = '';

            response.on('data', function(data) {
                body += data;
            });

            response.on('end', function() {
                delete options.agent;

                var responseContentType = response.headers['content-type'];

                if (/application\/javascript/.test(responseContentType)
                    || /application\/json/.test(responseContentType)) {
                    console.log(util.inspect(body));
                }

                // Set Headers and Call
                req.resultHeaders = response.headers;
                req.call = url.parse(options.host + options.path);
                req.call = url.format(req.call);
		req.statusCode = response.statusCode;


                if (apiConfig.enableCookie && req.resultHeaders['set-cookie']) {
                  var cookie = parseCookie(req.resultHeaders['set-cookie'][0]);
                  res.cookie(cookie.key, cookie.value, cookie.options);
                }

                // Response body
                req.result = body;

                console.log(util.inspect(body));

                next();
            })
        }).on('error', function(e) {
            if (config.debug) {
                console.log('HEADERS: ' + JSON.stringify(res.headers));
                console.log("Got error: " + e.message);
                console.log("Error: " + util.inspect(e));
            }
        });

        if(content !== ''){
            apiCall.write(content,'utf-8');
        }
        apiCall.end();
    }
}

var cachedApiInfo = [];

function checkPathForAPI(req, res, next) {
    if (!req.params) req.params = {};
    if (!req.params.api) {
        // If api wasn't passed in as a parameter, check the path to see if it's there
        var pathName = req.url.replace('/','');
        // Is it a valid API - if there's a config file we can assume so
        fs.stat(path.join(config.apiConfigDir, pathName + '.json'), function (error, stats) {
            if (stats) {
                req.params.api = pathName;
            }
            next();
        });
    } else {
        next();
    }

}

// Replaces deprecated app.dynamicHelpers that were dropped in Express 3.x
// Passes variables to the view
function dynamicHelpers(req, res, next){
    if (req.params.api) {
        res.locals.apiInfo = apisConfig[req.params.api];
        res.locals.apiName = req.params.api;
        res.locals.apiDefinition = JSON.parse(JSON.minify(fs.readFileSync(path.join(config.apiConfigDir, req.params.api + '.json'), 'utf8')));

        var apiDefData = getData(req.params.api);
        processApiIncludes(apiDefData, req.params.api);
        cachedApiInfo = apiDefData;

        // If the cookie says we're authed for this particular API, set the session to authed as well
        if (req.session[req.params.api] && req.session[req.params.api]['authed']) {
            req.session['authed'] = true;
        }
    } else {
        res.locals.apiInfo = apisConfig;
    }

    res.locals.session = req.session;
    next();
}

/*
   Can be called in the following ways:
        getData("klout");
        getData("klout", "./klout/get-methods.json");
        getData("klout", "/user/home/klout/klout.json");
        getData("klout", "/user/home/random/nonsense.json");

*/
function getData(api, passedPath) {
    var end = ".json";
    var loc;
    // Error checking
    if ( /[A-Za-z_\-\d]+/.test(api)) {
        //console.log('Valid input for API name.');
    }
    else {
        console.log('API name provided contains invalid characters.');        
    }

    /*
       Check whether api-name given is in apiconfig.
       Check whether api has 'href' property in config.
       If so, check if 'href' property is of 'file' or 'htttp'.
       If 'file', check that 'href' property contains a directory; print warning
        if not a directory
       Check if there was a second argument given (passedPath)
       If passedPath, check whether it is a relative path (should start with './'
        if it is).
       Otherwise, check that the passedPath is of 'file' type and get the data
        from it. Assuming a full path is being given.
       If no passedPath, attempt to return the api-name.json file from the directory
        given in the config file.
       If no 'href' property in given config for given api name, but passedPath
        exists with a relative directory, use default location and attempt to
        return data.
       If no 'href' property and no passedPath, attempt to get api-name.json from
        default location (iodocs installation directory + '/public/data').
       If given api name isn't found in the config file, print statement stating
        as much.
    */

    if (apisConfig.hasOwnProperty(api)) {
        if (apisConfig[api].hasOwnProperty('href')) {
            loc = url.parse(apisConfig[api]['href']);

            if (loc.protocol.match(/^file:$/)) {
                // Need a directory check on loc.path here
                // Not sure if that should be sync or async.
                if (undefined !== passedPath) {
                    if (/^.\//.test(passedPath)) {
                        return require(pathy.resolve(loc.path, passedPath));
                    }
                    else if (url.parse(passedPath).protocol
                            && url.parse(passedPath).protocol.match(/^file:$/)) {
                        return require(passedPath);
                    }
                }
                else {
                    return require(pathy.join(loc.path + api + end));
                }
            }
        }
        else if (/^.\//.test(passedPath)) {
            return require(pathy.resolve(__dirname + '/public/data/' , passedPath));
        }
        else {
            var tmp = JSON.parse(JSON.minify(fs.readFileSync(path.join(config.apiConfigDir, api + '.json'), 'utf8'))); 
            return tmp;
        }
    }
    else {
        console.log("'" + api + "' does not exist in config file.");
    }
}

// This function was developed with the assumption that the starting input
// would be the main api file, which would look like the following:
//    { "endpoints":
//        [...]
//    }
//
// The include statement syntax looks like this:
//    {
//        "external":
//        {
//            "href": "./public/data/desired/data.json",
//            "type": "list"
//        }
//    }
// "type": "list" is used only when the contents of the file to be included is a list object 
// that will be merged into an existing list. 
// An example would be storing all the get methods for an endpoint as a list of objects in 
// an external file.
function processApiIncludes (jsonData, apiName) {
    // used to determine object types in a more readable manner
    var what = Object.prototype.toString;
    var includeKeyword = 'external';
    var includeLocation = 'href';

    if (typeof jsonData === "object") {
        for (var key in jsonData) {
            // If an object's property contains an array, go through the objects in the array
            //  Endpoints and Methods are examples of this
            //  Endpoints contains a list of javascript objects, which are easily split into individual files.
            //      Each endpoint is basically a 1 to 1 javascript object relationship
            //  Methods aren't quite as nice.
            //      It could be convenient to split methods into get/put/post/delete externals.
            //      This then creates a 1 to many javascript object relationship
            if (what.call(jsonData[key]) === '[object Array]') {
                var i = jsonData[key].length;

                // Iterating through the array in reverse so that if an element needs to be replaced
                // by multiple elements, the array index does not need to be updated. 
                while (i--) {
                    var arrayObj = jsonData[key][i];
                    if ( includeKeyword in arrayObj ) {
                        var tempArray = getData(apiName, arrayObj[includeKeyword][includeLocation]);
                        // 1 include request to be replaced by multiple objects (methods)
                        if (arrayObj[includeKeyword]['type'] == 'list') {

                            // recurse here to replace values of properties that may need replacing
                            processApiIncludes(tempArray, apiName);
                            // why isn't this jsonData[key][i]?
                            //  Because the array itself is being replaced with an updated version
                            jsonData[key] = mergeExternal(i, jsonData[key], tempArray);

                        }
                        // 1 include request to be replaced by 1 object (endpoint)
                        else {
                            jsonData[key][i] = tempArray;
                            processApiIncludes(jsonData[key][i], apiName);
                        }
                    }
                }
            }

            // If an object's property contains an include statement, this will handle it.
            if (what.call(jsonData[key]) === '[object Object]') {
                for (var property in jsonData[key]) {
                    if (what.call(jsonData[key][property]) === '[object Object]') {
                        if (includeKeyword in jsonData[key][property]) {
                            jsonData[key][property] = getData(apiName, jsonData[key][property][includeKeyword][includeLocation]);
                            processApiIncludes(jsonData[key][property], apiName);
                        }
                    }
                }
            }
        }
    }
}

// Takes the array position of an element in array1, removes that element, 
// and in its place, the contents of array2 are merged in.
function mergeExternal (arrayPos, array1, array2) {
    var a1_tail = array1.splice(arrayPos, array1.length);
    a1_tail.splice(0, 1);
    return array1.concat(array2).concat(a1_tail);
}

// Search function.
// Expects processed API json data and a search term.
// There should be no 'external' link objects present.
function search (jsonData, searchTerm) {
    // From: http://simonwillison.net/2006/Jan/20/escape/#p-6
    var regexFriendly = function(text) {
        return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
    };

    // If ' OR ' is present in the search string, the search term will be split on ' OR ',
    // and the first two parts will be used. These two parts will have spaces 
    // stripped from them and then the regex term will present results that contain
    // matches that have either term.
    //
    // If ' OR ' is not present, the given term will be searched for, spaces will not be 
    // removed from the given term in this case.
    var regex;
    if (/\s+OR\s+/.test(searchTerm)) {
        var terms = searchTerm.split(/\s+OR\s+/);
        terms[0] = regexFriendly(terms[0].replace(/\s+/, ''));
        terms[1] = regexFriendly(terms[1].replace(/\s+/, ''));
        regex = new RegExp ( "("+terms[0]+"|"+terms[1]+")" , "i");
    }
    else {
        var terms = searchTerm.split(/\s+/);
        var regexString = "";
        for (var t = 0; t < terms.length; t++) {
            regexString += "(?=.*" + regexFriendly(terms[t]) + ")";
        }
        regex = new RegExp( regexString, "i" );
    }

    // Get a list of all methods from the data.
    var searchMatches = [];

    // Iterate through endpoints
    for (var i = 0; i < jsonData.endpoints.length; i++) {
        var object = jsonData.endpoints[i];

        // Iterate through methods
        for (var j = 0; j < object.methods.length; j++) {
            if ( filterSearchObject(object.methods[j], regex) ) {
                searchMatches.push({"label":object.methods[j]['MethodName'], "category": object.name, "type":object.methods[j]['HTTPMethod']});
            }
        }
    }

    return searchMatches;
}

// Method searching function
// Recursively check properties of a method object for a match to the given search term.
function filterSearchObject (randomThing, regex) {
    var what = Object.prototype.toString;
    if (what.call(randomThing) === '[object Array]') {
        for (var i = 0; i < randomThing.length; i++) {
            if (filterSearchObject(randomThing[i], regex)) {
                return true;
            }
        }
    }
    else if (what.call(randomThing) === '[object Object]') {
        for (var methodProperty in randomThing) {
            if (randomThing.hasOwnProperty(methodProperty)) {
                if (filterSearchObject(randomThing[methodProperty], regex)) {
                    return true;
                }
            }
        }
    }
    else if (what.call(randomThing) === '[object String]' || what.call(randomThing) === '[object Number]' ) {
        if ( regex.test(randomThing)) {
            return true;
        }
    }
    else {
        return false;
    }

    return false;
}

//
// Routes
//
app.get('/', function(req, res) {
    res.render('listAPIs', {
        title: config.title
    });
});

//
// Search function
//
// Note: If a change is made to app.js, the node process restarted, and the search 
// function  is used immediately without restart, there will be an error coming from the 
// search() function regarding the use of '.length'. Refresh the page, and the error 
// will go away. A page refresh is necessary to create a cached version of the api 
// which this route uses.
//  Not sure what the fix for this is.
app.get('/search', function(req, res) {
    var searchTerm = decodeURIComponent(req.query.term);
    res.send( search(cachedApiInfo, searchTerm) );
});

// Process the API request
app.post('/processReq', oauth, processRequest, function(req, res) {
    var result = {
        headers: req.resultHeaders,
        response: req.result,
        call: req.call,
        code: req.res.statusCode
    };
    res.send(result);
});

// Just auth
app.all('/auth', oauth);
app.all('/auth2', oauth2);


// OAuth callback page, closes the window immediately after storing access token/secret
app.get('/authSuccess/:api', oauthSuccess, function(req, res) {
    res.render('authSuccess', {
        title: 'OAuth Successful'
    });
});

// OAuth callback page, closes the window immediately after storing access token/secret
app.get('/oauth2Success/:api', oauth2Success, function(req, res) {
    res.render('authSuccess', {
        title: 'OAuth Successful'
    });
});

app.post('/upload', function(req, res) {
  res.redirect('back');
});

// API shortname, all lowercase
app.get('/:api([^\.]+)', function(req, res) {
    req.params.api=req.params.api.replace(/\/$/,'');
    res.render('api');
});

// Only listen on $ node app.js

if (!module.parent) {
    if (typeof config.socket != "undefined") {
        var args = [config.socket];
        console.log("Express server starting on UNIX socket %s", args[0]);
    } else {
        var args = [process.env.PORT || config.port, config.address];
        console.log("Express server starting on %s:%d", args[1], args[0]);
    }

    app.listen.apply(app, args);
}

function parseCookie(rc) {
  var list = {options: {}};

  rc && rc.split(';').forEach(function( cookie, index) {
    var parts = cookie.split('=');
    if (index == 0) {
      list.key = parts.shift().trim();
      list.value = decodeURIComponent(parts.join('='));
    } else {
      list.options[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    }
  });

  return list;
}
