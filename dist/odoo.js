'use strict';
angular.module('odoo', []);

'use strict';
angular.module('odoo').provider('jsonRpc', function jsonRpcProvider() {
    this.odooRpc = {
        odoo_server: "",
        uniq_id_counter: 0,
        context: {'lang': 'fr_FR'},
        shouldManageSessionId: false, //try without first
        errorInterceptors: [],
        authorization: ""
    };

    var preflightPromise = null;

    this.$get = ["$http", "$q", "$timeout", '$rootScope', '$state', function ($http, $q, $timeout, $rootScope, $state) {

        var url_poll = '/longpolling/poll';
        var url_version_info = '/web/webclient/version_info';

        /**
         * editLoading
         *              is used to show the loader when
         *              performs an http request to the server
         *              polling and version info requests
         *              not manage the loader
         * @param url
         *              url of http request
         * @param edit
         *              +1 if perform an http request
         *              -1 if the server responds
         */
        var editLoading = function (url, edit) {
            if (url.indexOf(url_poll) == -1 && url.indexOf(url_version_info) == -1) {
                $rootScope.loading += edit;
            }
        };

        var odooRpc = this.odooRpc;

        var processLoginResponse = function (result) {
            if (!result.uid) {
                cookies.delete_sessionId();
                return $q.reject({
                    title: 'wrong_login',
                    message: "Username and password don't match",
                    fullTrace: result
                });
            }
            odooRpc.context = result.user_context;
            cookies.set_sessionId(result.session_id);
            return result;
        };

        /**
         * simpleLogin
         *       update cookie (session_id) in both cases
         * @return promise
         *       resolve promise if credentials ok
         *       reject promise if credentials ko (with {title: wrong_login})
         *       reject promise in other cases (http issues, server error)   
         */
        odooRpc.simpleLogin = function (db, pin) {
            var params = {
                db: db,
                pin: pin
            };

            return odooRpc.sendRequest('/web/session/authenticate_pin', params).then(function (result) {
                return processLoginResponse(result);
            });
        };

        /**
         * login
         *       update cookie (session_id) in both cases
         * @return promise
         *       resolve promise if credentials ok
         *       reject promise if credentials ko (with {title: wrong_login})
         *       reject promise in other cases (http issues, server error)   
         */
        odooRpc.login = function (db, login, password) {
            var params = {
                db: db,
                login: login,
                password: password
            };

            return odooRpc.sendRequest('/web/session/authenticate', params).then(function (result) {
                return processLoginResponse(result);
            });
        };

        /**
         * check if logged in or not
         * @param force 
         *       if false -> check the cookies and return boolean
         *       if true -> check with the server if still connected return promise
         * @return boolean || promise
         *
         */
        odooRpc.isLoggedIn = function (force) {
            if (!force)
                return cookies.get_sessionId().length > 0;

            return odooRpc.getSessionInfo().then(function (result) {
                cookies.set_sessionId(result.session_id);
                return !!(result.uid);
            });
        };

        /**
         * logout (delete cookie)
         * @param force
         *       if true try to connect with falsy ids
         * @return null || promise 
         */
        odooRpc.logout = function (force) {
            cookies.delete_sessionId();
            if (force)
                return odooRpc.getSessionInfo().then(function (r) { //get db from sessionInfo
                    if (r.db)
                        return odooRpc.login(r.db, '', '');
                });
            return $q.when();
        };

        odooRpc.searchRead = function (model, domain, fields, context, limit, sort) {
            var params = {
                model: model,
                domain: domain,
                fields: fields,
                context: context,
                limit: limit,
                sort: sort,
            }
            return odooRpc.sendRequest('/web/dataset/search_read', params);
        };

        odooRpc.getSessionInfo = function (model, method, args, kwargs) {
            return odooRpc.sendRequest('/web/session/get_session_info', {});
        };

        odooRpc.getServerInfo = function (model, method, args, kwargs) {
            return odooRpc.sendRequest(url_version_info, {});
        };

        odooRpc.getDbList = function () {
            return odooRpc.sendRequest('/web/database/get_list', {});
        };
        odooRpc.syncDataImport = function (model, func_key, base_domain, filter_domain, limit, object) {
            return odooRpc.call(model, 'get_sync_data', [
                func_key, object.timekey, base_domain, filter_domain, limit
            ], {}).then(function (result) {
                //if (object.timekey === result.timekey) TODO: add mutlidomain before uncomment
                // return; //no change since last run
                object.timekey = result.timekey;

                angular.forEach(result.remove_ids, function (id) {
                    delete object.data[id];
                });

                if (Object.keys(result.data).length) {
                    angular.merge(object.data, result.data); ///merge deeply old with new
                    return odooRpc.syncDataImport(model, func_key, base_domain, filter_domain, limit, object);
                }
            });
        };

        odooRpc.syncImportObject = function (params) {
            /* params = {
             model: 'odoo.model',
             func_key: 'my_function_key',
             domain: [],
             limit: 50,
             interval: 5000,
             }

             When an error happens, the sync cycle is interrupted.

             An optional parameter 'onErrorRetry' can be specified. If its value is
             true, then the sync cycle will continue on the next interval even when
             errors occur. For a more fine-grained control over the retries,
             'onErrorRetry' could also be a function, taking the error as argument.
             It should call 'nextSync()' on the synchronized object's API to delay
             the next sync iteration.

             Example:

             params = {
             ...
             onErrorRetry: function(sync, err) {
             if(shouldRetry(err)) {
             sync.nextSync();
             }
             }
             }

             return a synchronized object where you can access
             to the data using object.data
             */
            var stop = false;
            var watchers = [];
            var object = {
                data: {},
                timekey: null,
                stopCallback: function () {
                    stop = true;
                },
                watch: function (fun) {
                    watchers.push(fun);
                },
                nextSync: nextSync
            };

            function nextSync(interval) {
                if (!stop) {
                    $timeout(sync, interval || params.interval);
                }
            }

            function runWatchers(data) {
                watchers.forEach(function (fun) {
                    fun(object);
                });
            }

            var errorCallback = null;
            if (angular.isFunction(params.onErrorRetry)) {
                errorCallback = function (err) {
                    params.onErrorRetry(object, err);
                };
            } else if (params.onErrorRetry) {
                errorCallback = function (err) {
                    nextSync();
                };
            }

            function sync() {

                odooRpc.syncDataImport(
                        params.model,
                        params.func_key,
                        params.base_domain,
                        params.filter_domain,
                        params.limit,
                        object)
                        .then(nextSync)
                        .then(runWatchers)
                        .catch(errorCallback);
            }
            sync();

            return object;
        };

        odooRpc.call = function (model, method, args, kwargs, request_id) {
            kwargs = kwargs || {};
            kwargs.context = kwargs.context || {};
            angular.extend(kwargs.context, odooRpc.context);

            var params = {
                model: model,
                method: method,
                args: args,
                kwargs: kwargs
            };
            return odooRpc.sendRequest('/web/dataset/call_kw', params, request_id);
        };

        odooRpc.poll = function (id_last_poll) {
            var params = {
                channels: ["notify_warning_1", "notify_info_1"],
                last: id_last_poll,
            };
            return odooRpc.sendRequest(url_poll, params);
        };

        odooRpc.callButton = function (model, method, args, context_id, domain_id) {
            var params = {
                model: model,
                method: method,
                args: args,
                context_id: context_id,
                domain_id: domain_id
            };
            return odooRpc.sendRequest('/web/dataset/call_button', params);
        };


        /**
         * base function
         */
        odooRpc.sendRequest = function (url, params, request_id) {

            /** (internal) build request for $http
             * keep track of uniq_id_counter
             * add session_id in the request (for Odoo v7 only) 
             */
            function buildRequest(url, params) {
                odooRpc.uniq_id_counter += 1;
                if (odooRpc.shouldManageSessionId)
                    params.session_id = cookies.get_sessionId();

                var json_data = {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: params, //payload
                };
                var headers = {
                    'Content-Type': 'application/json',
                    'X-Openerp-Session-Id': cookies.get_sessionId(),
                    'X-Jit40-Request-Id': request_id
                };
                if(odooRpc.authorization !== "") {
                    headers['Authorization'] = odooRpc.authorization;
                }
                return {
                    'method': 'POST',
                    'url': odooRpc.odoo_server + url,
                    'data': JSON.stringify(json_data),
                    'headers': headers,
                    'id': ("r" + odooRpc.uniq_id_counter),
                };
            }

            /** (internal) Odoo do some error handling and doesn't care
             * about HTTP response code
             * catch errors codes here and reject
             *   @param response $http promise
             *   @return promise 
             *       if no error : response.data ($http.config & header stripped)
             *       if error : reject with a custom errorObj
             */
            function handleOdooErrors(response) {
                editLoading(response.config.url, -1);
                if (!response.data.error)
                    return response.data;

                var error = response.data.error;
                var errorObj = {
                    title: '',
                    message: '',
                    fullTrace: error
                };

                if (error.code === 200 && error.message === "Odoo Server Error" && error.data.name === "werkzeug.exceptions.NotFound") {
                    errorObj.title = 'page_not_found';
                    errorObj.message = 'HTTP Error';

                    console.log('page not found');
                    $rootScope.$broadcast('session_expired');
                } else if ((error.code === 100 && error.message === "Odoo Session Expired") || //v8
                        (error.code === 300 && error.message === "OpenERP WebClient Error" && error.data.debug.match("SessionExpiredException")) //v7
                        ) {
                    errorObj.title = 'session_expired';
                    cookies.delete_sessionId();

                    $rootScope.$broadcast('session_expired');
                } else if ((error.message === "Odoo Server Error" && /FATAL:  database "(.+)" does not exist/.test(error.data.message))) {
                    errorObj.title = "database_not_found";
                    errorObj.message = error.data.message;
                } else if ((error.data.name === "openerp.exceptions.AccessError")) {
                    errorObj.title = 'AccessError';
                    errorObj.message = error.data.message;
                } else {
                    var split = ("" + error.data.fault_code).split('\n')[0].split(' -- ');
                    if (split.length > 1) {
                        error.type = split.shift();
                        error.data.fault_code = error.data.fault_code.substr(error.type.length + 4);
                    }

                    if (error.code === 200 && error.type) {
                        errorObj.title = error.type;
                        errorObj.message = error.data.fault_code.replace(/\n/g, "<br />");
                    } else {
                        errorObj.title = error.message;
                        errorObj.message = error.data.debug.replace(/\n/g, "<br />");
                    }
                }
                odooRpc.errorInterceptors.forEach(function (i) {
                    i(errorObj);
                });
                return $q.reject(errorObj)
            }

            /**
             *   (internal)
             *   catch HTTP response code (not handled by Odoo ie Error 500, 404)
             *   @params $http rejected promise
             *   @return promise
             */
            function handleHttpErrors(reason) {
                editLoading(reason.config.url, -1);
                var errorObj = {title: 'http', fullTrace: reason, message: 'HTTP Error'};
                odooRpc.errorInterceptors.forEach(function (i) {
                    i(errorObj);
                });
                return $q.reject(errorObj);
            }

            /**
             *   (internal) wrapper around $http for handling errors and build request
             */
            function http(url, params) {
                var req = buildRequest(url, params);
                editLoading(url, 1);
                return $http(req).then(handleOdooErrors, handleHttpErrors);
            }

            /** (internal) determine if session_id shoud be managed by this lib
             * more info: 
             *   in v7 session_id is returned by the server in the payload 
             *       and it should be added in each request's paylaod.
             *       it's 
             *
             *   in v8 session_id is set as a cookie by the server
             *       therefor the browser send it on each request automatically
             *
             *   in both case, we keep session_id as a cookie to be compliant with other odoo web clients 
             *
             */
            function preflight() {
                //to perform only one http request to get version info
                if (!preflightPromise) {
                    preflightPromise = http(url_version_info, {}).then(function (reason) {
                        odooRpc.shouldManageSessionId = (parseFloat(reason.result.server_serie) > 8 && parseFloat(reason.result.server_serie) < 10); //server_serie is string like "7.01"
                        preflightPromise = $q.when(); //runonce
                    }, function() {
                        preflightPromise = null;
                    });
                }
                return preflightPromise;
            }

            return preflight().then(function () {
                return http(url, params).then(function (response) {
                    var subRequests = [];
                    if (response.result.type === "ir.actions.act_proxy") {
                        angular.forEach(response.result.action_list, function (action) {
                            subRequests.push($http.post(action['url'], action['params']));
                        });
                        return $q.all(subRequests);
                    } else
                        return response.result;
                });
            });
        };

        return odooRpc;
    }];

    var cookies = (function () {
        var session_id; //cookies doesn't work with Android Default Browser / Ionic
        return {
            delete_sessionId: function () {
                session_id = null;
                document.cookie = 'session_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
                // TODO delete on next release
                document.cookie = 'session_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT;';
            },
            get_sessionId: function () {
                return document.cookie.split('; ')
                    .filter(function (x) {
                        return x.indexOf('session_id') === 0;
                    })
                    .map(function (x) {
                        return x.split('=')[1];
                    })
                    .pop() || session_id || "";
            },
            set_sessionId: function (val) {
                document.cookie = 'session_id=' + val + '; path=/';
                session_id = val;
            }
        };
    }());
});

