angular.module('pouch', [])



    // A service that defers the return of the pouchdb instance so that it has time to
    // initialise/load..
    .provider('lazyPouchDB', function LazyPouchDBProvider() {
        var INDEXES = {
            asana_tasks_index: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.source == 'asana') {
                        emit(doc.id, doc);
                    }
                }
            },
            asana_tasks_index_workspace: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.source == 'asana') {
                        emit(doc.workspaceId, doc);
                    }
                }
            },
            asana_tasks_index_workspace_incomplete: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.source == 'asana' && !doc.completed) {
                        emit(doc.workspaceId, doc);
                    }
                }
            },
            asana_tasks_index_workspace_inactive_tasks: {
                map: function (doc) {
                    if (doc.type == 'task' && !doc.active && doc.source == 'asana') {
                        emit(doc.workspaceId, doc);
                    }
                }
            },
            asana_tasks_index_workspace_inactive_tasks_incomplete: {
                map: function (doc) {
                    if (doc.type == 'task' && !doc.active && doc.source == 'asana' && !doc.completed) {
                        emit(doc.workspaceId, doc);
                    }
                }
            },
            active_user_index: {
                map: function (doc) {
                    if (doc.type == 'user' && doc.active) {
                        emit(doc.id, doc);
                    }
                }
            },
            active_tasks: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.active ) {
                        emit(doc._id, doc);
                    }
                }
            },
            active_uncompleted_tasks: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.active && !doc.completed) {
                        emit(doc._id, doc);
                    }
                }
            },
            task_by_asana_id: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.source == 'asana') {
                        emit(doc.id, doc);
                    }
                }
            },
            active_tasks_by_asana_id: {
                map: function (doc) {
                    if (doc.type == 'task' && doc.active && doc.source == 'asana') {
                        emit(doc.id, doc);
                    }
                }
            }
        };

        this.INDEXES = INDEXES;

        this.$get = function ($q, $log) {
            var pouch = null;
            var deferred = $q.defer();

            /**
             * Takes a couchdb design doc and inserts this into the database.
             * @param index
             * @param name
             * @returns promise
             * @private
             * @param callback
             */
            function __installIndex(index, name, callback) {
                $log.debug('installing index:', index, name);
                pouch.put(index).then(function (resp) {
                    if (callback) callback(null, resp);
                }, function (err) {
                    if (err.status == 409) { // Already exists.
                        $log.debug('index ' + name + ' already exists, therefore ignoring');
                        if (callback) callback(null);
                    }
                    else {
                        $log.error('error installing index ' + name, err);
                        if (callback) callback(err);
                    }
                });
            }

            /**
             * Given a name and a map function, creates a pouchdb 'index'
             * An index is essentially a couchdb design document with a single view.
             * See http://pouchdb.com/2014/05/01/secondary-indexes-have-landed-in-pouchdb.html for more explanations on this
             * and why they're useful.
             * @param name the name of the index
             * @param map a couchdb/puchdb map function
             * @param reduce a couchdb/puchdb reduce function
             * @returns promise a promise to install the new index
             * @param callback
             */
            function installIndex(name, map, reduce, callback) {
                var views = {};
                views[name] = {map: map.toString()};
                if (reduce) {
                    views[name].reduce = reduce.toString();
                }
                __installIndex({
                    _id: '_design/' + name,
                    views: views
                }, name, callback);
            }

            function _initialisePouchDB() {
                $log.debug('_initialisePouchDB');
                var indexesInstalled = 0;
                var errors = [];
                var numIndexes = 0;
                for (var key in INDEXES) {
                    if (INDEXES.hasOwnProperty(key)) {
                        numIndexes++;
                    }
                }
                /**
                 * Checks to see if all indexes have been installed (or otherwise)
                 */
                function checkFinished() {
                    $log.debug('checkFinished');
                    if ((indexesInstalled + errors.length) == numIndexes) {
                        if (errors.length) {
                            $log.error('Errors initialising pouch:', errors);
                            deferred.reject(errors);
                        }
                        else {
                            $log.info('All indexes are now installed');
                            deferred.resolve(pouch);
                        }
                    }
                }
                var completion = function (err) {
                    if (err) {
                        $log.debug('onFail', {err: err});
                        errors.push(err);
                        checkFinished();
                    }
                    else {
                        $log.debug('onSuccess');
                        indexesInstalled++;
                        checkFinished();
                    }
                };
                $log.info('There are ' + numIndexes + ' indexes to install');
                for (var name in INDEXES) {
                    if (INDEXES.hasOwnProperty(name)) {
                        $log.debug('installing index', name);
                        installIndex(name, INDEXES[name].map, INDEXES[name].reduce, completion);
                    }
                }
                return deferred.promise;
            }

            /**
             * Sets up pouchdb instance, installs indexes (if not already installed) and configures
             * the promise.
             * @returns {*}
             */
            function initialisePouchDB() {
                pouch = new PouchDB('db');
                return _initialisePouchDB();
            }

            /**
             * This is a nice little workaround for the confusing revision identifiers
             * with pouchdb.
             * https://github.com/pouchdb/pouchdb/issues/1691 demonstrates the confusion nicely and contains
             * the function below that has been adapted to latest pouch versions.
             * @param doc
             * @returns promise
             */
            function retryUntilWritten(doc) {
                var HTTP_CONFLICT = 409;
                $log.debug('retryUntilWritten:', doc);
                var retryDeferred = $q.defer();
                deferred.promise.then(function (db) {
                    $log.debug('here we go');
                    db.get(doc._id).then(function (origDoc) {
                        $log.debug('here we go again');
                        doc._rev = origDoc._rev;
                        return db.put(doc).then(function (resp) {
                            doc._id = resp.id;
                            doc._rev = resp.rev;
                            retryDeferred.resolve(doc);
                        }, retryDeferred.reject);
                    }, function (err) {
                        if (err.status === HTTP_CONFLICT) {
                            $log.debug('conflict, retrying');
                            retryUntilWritten(doc).then(retryDeferred.resolve, retryDeferred.reject);
                        } else { // new doc
                            $log.debug('1');
                            // Avoid https://github.com/pouchdb/pouchdb/issues/2570 by only passing id param
                            // if one doesn't exist in the object itself.
                            return db.put(doc).then(function (resp) {
                                $log.debug('successfully created new doc:', resp);
                                retryDeferred.resolve(resp);
                            }, function (err) {
                                $log.error('error creating new doc:', err, doc._id);
                                retryDeferred.reject(err);
                            });
                        }
                    });
                }, retryDeferred.reject);
                return retryDeferred.promise;
            }

            /**
             * Set key to value in PouchDB eventually, resolving conflicts.
             *
             * @param doc either the identifier of a doc or an object with _id & _rev
             * @param key the attribute we want to set
             * @param value the vlaue of the attribute
             * @param callback
             */
            function setEventually(doc, key, value, callback) {
                var updates = {};
                updates[key] = value;
                return _setEventually(doc, updates, callback);
            }

            function _setEventually(doc, updates, callback) {

                function updateDoc (doc) {
                    for (var key in updates) {
                        if (updates.hasOwnProperty(key)) {
                            doc[key] = updates[key];
                        }
                    }
                }

                getPromise(function (err, pouch) {
                    if (err) {
                        callback(err);
                    }
                    else {
                        function getAndThenPut(ident) {
                            pouch.get(ident, function (err, doc) {
                                if (err) {
                                    callback(err);
                                }
                                else {
                                    updateDoc(doc);
                                    put(doc);
                                }
                            });
                        }
                        function put(doc) {
                            pouch.put(doc, function (err, resp) {
                                if (err) {
                                    if (err.status === 409) {
                                        getAndThenPut(doc._id);
                                    }
                                    else {
                                        callback(err);
                                    }
                                }
                                else {
                                    doc._id = resp.id;
                                    doc._rev = resp.rev;
                                    callback(null, doc);
                                }
                            });
                        }
                    }
                    if (doc._id) {
                        updateDoc(doc);
                        put(doc);
                    }
                    else {
                        getAndThenPut(doc);
                    }
                });
            }

            initialisePouchDB();

            function getPromise (callback) {
                if (deferred) {
                    if (callback) {
                        deferred.promise.then(function (pouch) {
                            callback(null, pouch);
                        }, callback);
                    }
                    return deferred.promise;
                }
                if (callback) callback('no promise');
                return null;
            }

            return {
                getPromise: getPromise,
                inject: function (_pouch) {
                    $log.debug('inject');
                    var newDeferred = $q.defer();
                    $log.debug('inject2');
                    _pouch.info(function (err, info) {
                        if (!err) {
                            $log.debug('injecting:', info);
                            deferred.promise.then(function (dbInstance) {
                                deferred = newDeferred;
                                pouch = _pouch;
                                _initialisePouchDB().then(deferred.resolve, deferred.reject);
                            }, newDeferred.reject);
                        }
                        else {
                            $log.error('error getting info of injected pouchdb:', err);
                            newDeferred.reject(err);
                        }
                    });

                    return newDeferred.promise;
                },
                retryUntilWritten: retryUntilWritten,
                setEventually: setEventually,
                _setEventually: _setEventually
            };

        };
    })

;