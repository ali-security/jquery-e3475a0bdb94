/*
 * Headless runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Opens the suite in headless Chromium via puppeteer, streams one line per
 * test (module, name, PASS/FAIL, assertion counts) plus the failed assertion
 * messages, prints a summary and exits non-zero when any test fails, when no
 * test ran, or when the run times out.
 *
 * This file is a CI helper only: it is not linted by the Gruntfile
 * (jshint/jscs only cover src/, test/, Gruntfile.js and a few build/ files)
 * and .github/ is removed before `npm pack` by .github/workflows/build.yml,
 * so it never reaches the npm package.
 *
 * puppeteer is NOT a project dependency; it needs a modern node and is
 * installed into an isolated prefix, e.g.:
 *   npm install --prefix /tmp/runner puppeteer@1.20.0
 *   NODE_PATH=/tmp/runner/node_modules node .github/scripts/run-browser-tests.js
 *
 * The built tree must be served over HTTP with PHP executing (the ajax tests
 * hit test/data/*.php). CI uses Apache + mod_php via
 * .github/scripts/serve-with-apache.sh and sets
 * TEST_BASE_URL=http://127.0.0.1/jquery.
 *
 * Environment:
 *   TEST_BASE_URL       server root          (default http://127.0.0.1:8000)
 *   TEST_PAGE           page + query string  (default test/index.html?dev=true,
 *                       i.e. load the freshly built dist/jquery.js)
 *   TEST_TIMEOUT_MIN    overall timeout, minutes                 (default 20)
 *   TEST_STALL_MIN      fail if no test finishes for this long   (default 5)
 *   CHROME_PATH         optional Chromium/Chrome executable override
 *   CHROME_ARGS         optional extra Chromium flags, space separated
 */
"use strict";

var puppeteer = require( "puppeteer" );
var http = require( "http" );

var baseUrl = ( process.env.TEST_BASE_URL || "http://127.0.0.1:8000" ).replace( /\/+$/, "" );
var testPage = ( process.env.TEST_PAGE || "test/index.html?dev=true" ).replace( /^\/+/, "" );
var testUrl = baseUrl + "/" + testPage;
var overallTimeoutMs = Number( process.env.TEST_TIMEOUT_MIN || 20 ) * 60 * 1000;
var stallTimeoutMs = Number( process.env.TEST_STALL_MIN || 5 ) * 60 * 1000;
var MAX_DETAIL = 600;

var tests = { passed: 0, failed: 0 };
var failedTests = [];
var lastActivity = Date.now();
var startedAt = Date.now();
var finished = false;
var begun = false;
var browser = null;
var resolveDone;
var donePromise = new Promise( function( resolve ) {
	resolveDone = resolve;
} );

function log( line ) {
	process.stdout.write( line + "\n" );
}

function truncate( s ) {
	s = String( s );
	return s.length > MAX_DETAIL ? s.slice( 0, MAX_DETAIL ) + "...(truncated)" : s;
}

function httpGet( url ) {
	return new Promise( function( resolve, reject ) {
		var req = http.get( url, function( res ) {
			var body = "";
			res.setEncoding( "utf8" );
			res.on( "data", function( c ) {
				body += c;
			} );
			res.on( "end", function() {
				resolve( { status: res.statusCode, body: body } );
			} );
		} );
		req.on( "error", reject );
		req.setTimeout( 10000, function() {
			req.destroy( new Error( "timeout" ) );
		} );
	} );
}

// Wait for the PHP server and verify it actually executes PHP
// (test/data/name.php echoes the "name" parameter as ERROR/pan).
async function preflight() {
	var i, res, lastErr;
	for ( i = 0; i < 60; i++ ) {
		try {
			res = await httpGet( baseUrl + "/test/data/name.php?name=foo" );
			if ( res.status === 200 ) {
				break;
			}
			lastErr = new Error( "HTTP " + res.status );
		} catch ( e ) {
			lastErr = e;
		}
		res = null;
		await new Promise( function( r ) {
			setTimeout( r, 1000 );
		} );
	}
	if ( !res ) {
		throw new Error( "Test server " + baseUrl + " not reachable: " + lastErr );
	}
	if ( /<\?php/.test( res.body ) ) {
		throw new Error( "Server returned raw PHP source; PHP is not being executed" );
	}
	res = await httpGet( baseUrl + "/dist/jquery.js" );
	if ( res.status !== 200 ) {
		throw new Error( "dist/jquery.js not served (HTTP " + res.status + "); run the grunt build first" );
	}
	log( "Server OK: " + baseUrl + " (PHP executing, dist/jquery.js present)" );
}

// Runs in the page before any page script. Hooks QUnit's logging callbacks
// the moment qunit.js assigns window.QUnit, so nothing is missed even though
// the suite loads its modules asynchronously via require.js.
function pageHook() {
	if ( window.top !== window ) {
		return;
	}
	var current;
	function dump( v ) {
		try {
			return window.QUnit && window.QUnit.jsDump ? window.QUnit.jsDump.parse( v ) : String( v );
		} catch ( e ) {
			return String( v );
		}
	}
	function hook( Q ) {
		var failures = [];
		if ( !Q || Q.__headlessRunnerHooked ) {
			return;
		}
		Q.__headlessRunnerHooked = true;
		Q.begin( function() {
			var s = document.getElementById( "jquery-js" );
			window.__runnerEvent( {
				type: "begin",
				jquerySrc: s ? s.src : null,
				userAgent: navigator.userAgent
			} );
		} );
		Q.log( function( d ) {
			if ( !d.result ) {
				var f = { message: d.message || "(no message)" };
				if ( d.hasOwnProperty( "expected" ) ) {
					f.expected = dump( d.expected );
					f.actual = dump( d.actual );
				}
				if ( d.source ) {
					f.source = String( d.source ).split( "\n" ).slice( 0, 3 ).join( " | " );
				}
				failures.push( f );
			}
		} );
		Q.testDone( function( d ) {
			window.__runnerEvent( {
				type: "testDone",
				module: d.module,
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime,
				version: window.jQuery && window.jQuery.fn ? window.jQuery.fn.jquery : null,
				failures: failures
			} );
			failures = [];
		} );
		Q.done( function( d ) {
			window.__runnerEvent( {
				type: "done",
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return current;
		},
		set: function( v ) {
			current = v;
			try {
				hook( v );
			} catch ( e ) {
				window.__runnerEvent( { type: "hookError", message: String( e && e.stack || e ) } );
			}
		}
	} );
}

function onEvent( ev ) {
	var status, i, f;
	lastActivity = Date.now();
	if ( finished ) {
		return;
	}
	if ( ev.type === "begin" ) {
		// QUnit 1.14 runs "begin" from every QUnit.load() call (window load and
		// testinit's loadTests both call it); report it once.
		if ( begun ) {
			return;
		}
		begun = true;
		log( "QUnit started. jQuery under test: " + ev.jquerySrc );
		log( "Browser: " + ev.userAgent );
		if ( !ev.jquerySrc || ev.jquerySrc.indexOf( baseUrl + "/dist/" ) !== 0 ) {
			log( "ERROR: jQuery under test is not the locally built dist/ file" );
			resolveDone( { error: "wrong jQuery source: " + ev.jquerySrc } );
		}
	} else if ( ev.type === "testDone" ) {
		status = ev.failed ? "FAIL" : "PASS";
		if ( ev.failed ) {
			tests.failed++;
			failedTests.push( ev.module + " :: " + ev.name );
		} else {
			tests.passed++;
		}
		log( "[" + status + "] " + ev.module + " :: " + ev.name +
			" (" + ev.passed + "/" + ev.total + " assertions, " + ev.runtime + " ms)" );
		for ( i = 0; i < ev.failures.length; i++ ) {
			f = ev.failures[ i ];
			log( "    - " + truncate( f.message ) );
			if ( f.hasOwnProperty( "expected" ) ) {
				log( "        expected: " + truncate( f.expected ) );
				log( "        actual:   " + truncate( f.actual ) );
			}
			if ( f.source ) {
				log( "        at: " + truncate( f.source ) );
			}
		}
	} else if ( ev.type === "done" ) {
		resolveDone( { summary: ev } );
	} else if ( ev.type === "hookError" ) {
		log( "ERROR: failed to hook QUnit: " + ev.message );
		resolveDone( { error: "hook error" } );
	}
}

function printSummary( result ) {
	var s = result.summary,
		elapsed = Math.round( ( Date.now() - startedAt ) / 1000 ),
		totalTests = tests.passed + tests.failed,
		ok;

	log( "" );
	log( "==================== jQuery QUnit summary ====================" );
	log( "URL: " + testUrl );
	if ( failedTests.length ) {
		log( "Failed tests (" + failedTests.length + "):" );
		failedTests.forEach( function( t ) {
			log( "  * " + t );
		} );
	}
	log( "Tests: " + tests.passed + " passed, " + tests.failed + " failed of " + totalTests );
	if ( s ) {
		log( "Assertions: " + s.passed + " passed, " + s.failed + " failed of " + s.total +
			" (QUnit runtime " + s.runtime + " ms, wall " + elapsed + " s)" );
	} else {
		log( "Assertions: incomplete run (wall " + elapsed + " s)" );
	}
	ok = !!s && !result.error && s.failed === 0 && tests.failed === 0 && totalTests > 0;
	if ( result.error ) {
		log( "RESULT: ERROR - " + result.error );
	} else if ( totalTests === 0 ) {
		log( "RESULT: FAILED - no tests ran" );
	} else {
		log( "RESULT: " + ( ok ? "PASSED" : "FAILED" ) );
	}
	return ok;
}

async function main() {
	var page, result, watchdog, launchOpts;

	await preflight();

	launchOpts = {
		headless: true,
		args: [ "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage" ]
	};
	if ( process.env.CHROME_ARGS ) {
		launchOpts.args = launchOpts.args.concat( process.env.CHROME_ARGS.split( /\s+/ ).filter( Boolean ) );
	}
	if ( process.env.CHROME_PATH ) {
		launchOpts.executablePath = process.env.CHROME_PATH;
	}
	browser = await puppeteer.launch( launchOpts );
	page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 1024 } );

	page.on( "dialog", function( d ) {
		log( "  (dismissed " + d.type() + " dialog: " + truncate( d.message() ) + ")" );
		d.dismiss().catch( function() {} );
	} );
	page.on( "pageerror", function( err ) {
		log( "  (page error: " + truncate( err && err.message || err ) + ")" );
	} );
	page.on( "error", function( err ) {
		resolveDone( { error: "page crashed: " + err } );
	} );

	await page.exposeFunction( "__runnerEvent", onEvent );
	await page.evaluateOnNewDocument( pageHook );

	watchdog = setInterval( function() {
		var now = Date.now();
		if ( now - startedAt > overallTimeoutMs ) {
			resolveDone( { error: "overall timeout of " + ( overallTimeoutMs / 60000 ) + " min exceeded" } );
		} else if ( now - lastActivity > stallTimeoutMs ) {
			resolveDone( { error: "no test finished in the last " + ( stallTimeoutMs / 60000 ) + " min" } );
		}
	}, 5000 );

	log( "Opening " + testUrl );
	await page.goto( testUrl, { waitUntil: "load", timeout: 120000 } );

	result = await donePromise;
	finished = true;
	clearInterval( watchdog );
	return printSummary( result );
}

main().then( function( ok ) {
	process.exitCode = ok ? 0 : 1;
}, function( err ) {
	finished = true;
	log( "ERROR: " + ( err && err.stack || err ) );
	printSummary( { error: String( err && err.message || err ) } );
	process.exitCode = 1;
} ).then( function() {
	var closing = browser ? browser.close().catch( function() {} ) : Promise.resolve();
	var hardExit = setTimeout( function() {
		process.exit( process.exitCode );
	}, 15000 );
	return closing.then( function() {
		clearTimeout( hardExit );
		process.exit( process.exitCode );
	} );
} );
