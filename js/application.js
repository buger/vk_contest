(function(){ 
	var wnd = this;

	/*
		Util functions
	*/

	function fullName(user) {
		return user.first_name + " " + user.last_name;
	}

	var dateMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

	function formatTime(date) {
		var hours = date.getHours();
		var minutes = date.getMinutes();
		var postfix = "am";

		if (hours > 12) {
			postfix = "pm";
			hours = hours - 12;
		}

		if (minutes < 10) 
			minutes = "0" + minutes;

		return hours + ":" + minutes + " " + postfix;
	}

	function hashToQueryString(hash) {
		var arr = [];

		for (key in hash) {
			if (hash.hasOwnProperty(key) && hash[key] != void 0)
				arr.push(key + "=" + hash[key]);
		}

		return arr.join("&");
	}	

	
	/*
		Initializing storage for our data. All data store in localStorage.
	*/
	var Users = new Backbone.Collection();
	Users.localStorage = new BackboneStore('users');
	Users.fetch();

	var Groups = new Backbone.Collection();
	Groups.localStorage = new BackboneStore('groups');	
	Groups.fetch();

	var Posts = new Backbone.Collection();
	Posts.localStorage = new BackboneStore('posts');	
	Posts.fetch();

	function cacheEntities(type, items, id){
		_.each(items, function(item){
			// If not cached
			if (!type.get(item[id])) {
				// Backbone model need to have 'id' property
				item.id = item[id];
				type.create(item);
			}					
		});
	}


	/*
		Simple VK API wrapper
	*/
	var VK = {
		BASE_URL: "https://api.vkontakte.ru/method/",

		APP_ID: 2652054,
		SETTINGS: "notify,friends,photos,audio,video,docs,notes,pages,wall,groups",
		REDIRECT_URI: "http://buger.github.com/vk_contest",
		DISPLAY: "popup",

		SESSION: store.get('session') || {},		

		//Simple JSONP implementation
		callMethod: function(name, data, callback){
			var method_name = "clb" + Date.now();			

			data['access_token'] = VK.SESSION.access_token;
			data['callback'] = method_name;			

			var head = document.getElementsByTagName("head")[0];         
			var script = document.createElement('script');
			script.type = 'text/javascript';
			script.src = VK.BASE_URL + name + '?' + hashToQueryString(data);			
			head.appendChild(script);								

			wnd[method_name] = function(response) {				
				console.log(response);

				callback(response);				
								
				// Avoid memory leaks
				head.removeChild(script);
				delete wnd[method_name];
			}
		},


		loadProfile: function(user_id, callback){
			console.log('loading profile');

			// Unfortanetly wall.getComments did't support multiple post Id's, and VKScript did't support cycles. 
			// We have to use additional request to retrive wall comments.
			query = [
				"return({",
					'profile: API.getProfiles({',
					 	'uids:'+user_id+',fields:"photo,photo_big,counters,activity,relation,domain,bdate"',
					'})[0],',

				 	'activity: API.activity.get({uid:'+user_id+'}),',

				 	'photos: API.photos.getAll({owner_id:'+user_id+',count:4}),',

					// I did't find better method to get length
				 	'news_count: API.newsfeed.get().items@.length,', 
				 	
				 	'followers: API.getProfiles({',
				 		'uids:API.subscriptions.getFollowers({uid:'+user_id+',count:6}).users,fields:"photo"',
				 	'}),',

				 	'friends: API.friends.get({uid:'+user_id+',count:6,fields:"photo"}),',

				 	'wall: API.wall.get({owner_id:'+user_id+',count:10,extended:1})',

				 "});"
			].join('');


			VK.callMethod("execute", { code: query }, function(resp){
				var photos = resp.response.photos;

				user = resp.response.profile;

				user = _.extend(user, {
					id: resp.response.profile.uid,
					followers: resp.response.followers,
					friends: resp.response.friends,
					wall: _.rest(resp.response.wall.wall),
					photos: _.rest(resp.response.photos),
				});

				user.counters.news = resp.response.news_count.length;
				user.counters.photos = resp.response.photos[0];
				user.counters.wall = resp.response.wall.wall[0];
				
				cacheEntities(Groups, resp.response.wall.groups, 'gid');
				cacheEntities(Users, resp.response.wall.profiles, 'uid');				
				
				// Don't loose our photos cache
				if (cached_user = Users.get(user.id)) {
					if (cached_user.attributes.photos)
						user.photos = cached_user.attributes.photos;
				}

				user = Users.create(user);						
				
				if (callback) callback(user);
			});			
		},
		

		/*
			Loading wall comments with its users

			Sample query:
				var c0=API.wall.getComments({owner_id:327488,post_id:122,count:3});				
				...
				return({comments:[c0,c1,...], users:[API.getProfiles({uids:c0@.uid,fields:"picture"},...]});
		*/
		loadWallComments: function(user_id, posts, count, callback){
			if (!posts.length) return;

			if (count === void 0) count = 3;
			if (count === 0) count = 100;

			query = "";

			var comments_query = [];
			var users_query = [];

			_.each(posts, function(post, idx){
				query += 'var c'+idx+'=API.wall.getComments({owner_id:'+user_id+',post_id:'+post+',count:'+count+',sort:"desc"});';
				comments_query.push('c'+idx);
				users_query.push('API.getProfiles({uids:c'+idx+'@.uid,fields:"photo"})');
			});				

			query += ";return({comments:["+comments_query.join(',')+"], users:["+users_query+"]});";

			VK.callMethod("execute", { code: query }, function(resp){
				// Updating comments cache
				_.each(resp.response.comments, function(comments, idx){
					Posts.create({
						'id': user_id + "_" + posts[idx],
						'comments_count': comments[0],
						'comments': _.rest(comments)
					});
				});

				// Flattening array and removing nullable objects
				users = _.compact(_.flatten(resp.response.users));

				cacheEntities(Users, users, 'uid');				
				
				user = Users.get(user_id);

				if (callback) callback(user);
			});						
		},


		loadUserPhotos: function(user_id, offset, callback){
			VK.callMethod("photos.getAll", { owner_id:user_id, offset:offset, count:50 }, function(resp){
				var photos = _.rest(resp.response);
									
				user = Users.get(user_id);
				user.set({ 'photos': _.union(user.get('photos'), photos) });
				user.save();

				if (callback) callback(user);
			});
		},


		photoInfo: function(user_id, photo_id, callback) {
		
		},


		loadWall: function(user_id, offset, callback) {
			var params = { 
				owner_id: user_id, 
				offset: offset, 
				count: 10,
				extended: 1
			};

			VK.callMethod("wall.get", params, function(resp){
				var user = Users.get(user_id);

				user.set({ 
					'wall': _.union(user.get('wall'), _.rest(resp.response.wall)) 
				});

				cacheEntities(Groups, resp.response.groups, 'gid');
				cacheEntities(Users, resp.response.profiles, 'uid');

				if (callback) callback(user);
			});
		}
	}		

	if (wnd.location.hash.match(/access_token/)) {		
		var hash = this.location.hash.substr(1).split('&');

		var session = {}

		for (var param, i=0, l=hash.length; i<l; i++) {
			param = hash[i].split('=');

			session[param[0]] = param[1];
		}
		session['user_id'] = parseInt(session['user_id']);

		store.set('session', session);
		
		wnd.opener.location.hash = "logged";
		return wnd.close();			
	}

	if (wnd.location.hash.match(/error/)) {
		return wnd.close();
	}

	$('#login_button').bind('click', function(){		
		var url = ["http://api.vkontakte.ru/oauth/authorize?",			
	 			   "client_id=" + VK.APP_ID,
	 			   "scope=" + VK.SETTINGS,
	 			   "redirect_uri=" + VK.REDIRECT_URI,
	 			   "display=" + VK.DISPLAY,
	 			   "response_type=token"].join('&')

		var wnd = window.open(url, "auth_dialog", "menubar=0,resizable=0,width=600,height=400");			
	});	


	var WallView = Backbone.View.extend({
		
		el: $('section.profile'),

		template: $('#user_wall_template').html(),

		events: {
			"click .wall .show_all": "loadComments"
		},


		initialize: function(){
			_.bindAll(this, "render", "loadComments");
		},


		render: function(user){
			if (user && App.opened_user != user.id) 
				return false;

			this.model = user;
			
			// Because we can't load post comments among with userProfile, we displayng first level post messages, with comment stubs (only if post loaded first time), based on given count, and downloading rest of comments in background.
			var wall = _.map(user.get('wall'), function(post){
				var comments;
				var cache = Posts.get(user.id+"_"+post.id);

				// Creating stubs if not found in cache
				if (!cache) {
					comments = _.range(post.comments.count);
					comments = comments.map(function(){ return { } });
					comments = _.first(comments, 3);
				} else {																	
					comments = cache.get('comments');
					comments = _.sortBy(comments, function(c){ return c.date });
					
					// Colaps comments thread and show only last 3 comments					
					if (!post.opened)
						comments = _.last(comments, comments.length > 3 ? 3 : comments.length);
				}
			
				messages = _.union([post], comments);			

				return { 'messages': messages }
			});


			var view = {
				'posts': wall,
				'user': user.toJSON(),

				'full_name': function() {
					return fullName(this);
				},

				'formated_date': function(){
					var date = new Date(this.date*1000);
					var today = new Date();

					var is_today = today.getYear()  === date.getYear()  &&
					               today.getMonth() === date.getMonth() &&
					               today.getDay()   === date.getDay();

					var prefix = is_today ? 'today' : dateMonths[date.getMonth()] + " " + date.getDay();

					return prefix + " at " + formatTime(date)
				},				

				'user_comment': function(){
					var user_id = this.uid || this.from_id;

					if (!user_id) return {}

					return Users.get(user_id).toJSON();
				},

				'has_attachment': function(){
					return !!(this.attachments && this.attachments.length);
				},
				
				'attachment_preview': function(){	
					var tmpl = "";
					var att = this[this.type];
					
					switch (this.type) {
						case 'photo':
						case 'video':
							att.preview = att.image_small || att.src;
							tmpl = '<a href="#" class="{{type}}"><img src="{{preview}}"" /></a>';
							break;

						case 'link':
							tmpl = '{{#image_src}}<img src="{{image_src}}"/>{{/image_src}}' +
								   '<a href="{{url}}" title="{{title}}">{{title}}</a>' +
								   '<div>{{description}}</div></a>';
							break;
						
						case 'audio':
							tmpl = '<a>{{performer}} - {{title}}</a>';
							break;
					}
					
					console.log(this, this.type, tmpl);
									
					return $.mustache(tmpl, att);
				},

				'more_then_three_comments': function(){
					return this.comments && this.comments.count > 3;
				},

				'is_closed': function(){					
					return !this.opened;
				},
				
				'likes_count': function(){
					if (!this.likes) return 0;

					return this.likes.count === true ? 0 : this.likes.count;
				}
			};

			output = $.mustache(this.template, view);

			$('article section.profile .wall').html(output);
						

			// Updating comments. Updating only uncached and changed posts 
			var posts_to_update = _.select(user.get('wall'), function(post){ 
				var cache = Posts.get(user.id+"_"+post.id);

				return (!cache || cache.get('comments_count') != post.comments.count)							
			});			
			var post_ids = _.map(posts_to_update, function(post){ return post.id });

			// Second request to get comments;
			VK.loadWallComments(user.id, post_ids, void 0, _.bind(function(user){
				this.render(user);
			}, this));			
		},


		loadComments: function(evt){
			evt.target.innerHTML = 'Loading...';

			// data-post="#{user_id}_#{post_id}"
			var post_data = $(evt.target).attr('data-post').split('_');
			
			var post = _.detect(this.model.attributes.wall, function(item) {			
				return item.id === parseInt(post_data[1]);
			})
			post.opened = true;

			VK.loadWallComments(post_data[0], [post_data[1]], 0, _.bind(function(user){
				this.render(user);
			}, this));
		}

	});	


	var ProfileView = Backbone.View.extend({

		el: $('body>article'),
		
		profile_template: $('#user_profile_template').html(),
		photos_template: $('#user_photos_template').html(),

		events: {
			"click .photos .back": "openProfile"
		},


		initialize: function(){
			_.bindAll(this, "renderProfile", "renderPhotos", "loadMore");

			$(wnd).bind('scroll', this.loadMore);

			this.wall = new WallView();			
		},

		openProfile: function(){
			Router.navigate("/user/"+App.opened_user);
		},

		renderProfile: function(user){			
			if (App.opened_user != user.id) return false;		

			this.mode = 'profile';

			this.$('section.photos').hide();
			this.$('section.profile').show();

			this.model = user;	

			user = user.toJSON();

			var view = {
				'user': user,

				'have_photos': !!user.photos.length,
				'user_photos': _.first(user.photos, 4),
				
				'birthday': function(){
					if (!this.bdate) return false;

					var date = this.bdate.split('.')
					date[1] = dateMonths[date[1]-1];

					return [date[1],date[0],date[2]||""].join(" ");
				},

				'relationship': function(){
					var types = [false,'Single','In a Relationship','Engaged','Married','In love','It\'s Complicated','Actively Searching'];

					return types[this.relation];
				},

				'full_name': function() {
					return fullName(this);
				}		
			};

			output = $.mustache(this.profile_template, view);

			$('article section.profile').html(output);		
					
			this.wall.render(this.model);
		},


		renderPhotos: function(user) {
			if (App.opened_user != user.id) return false;

			this.mode = 'photos';

			this.$('section.profile').hide();
			this.$('section.photos').show();			

			this.model = user;
			user = user.toJSON();

			user_photos = user.photos;

			// If loading photos first time, showing stubs for missing photos and loading rest in background
			if (user_photos.length === 4) {
				photo_stubs = user.counters.photos - user_photos.length;

				if (photo_stubs > 50) photo_stubs = 50;

				photo_stubs = _.map(_.range(photo_stubs), function(){ return {} });

				user_photos = _.union(user_photos, photo_stubs);
				
				VK.loadUserPhotos(user.id, 4, _.bind(function(user){
					this.renderPhotos(user);
				}, this));
			}
				
			var view = {
				'user': user,

				'photos_count': user.counters.photos,
				'albums_count': user.counters.albums,

				'have_photos': !!user.photos.length,
				'user_photos': user_photos,

				'is_stub': function(){ return !this.pid }
			}			

			output = $.mustache(this.photos_template, view);
						
			$('article section.photos').html(output);					
		},


		// http://documentcloud.github.com/underscore/#throttle		
		loadMore: _.throttle(function(evt, force){
			var scroll_height = wnd.scrollY + wnd.innerHeight;

			if (force || ($(wnd.document.body).height() - scroll_height) < wnd.innerHeight) {
				if (this.mode === 'profile') {
					// If wall completly loaded
					if (this.model.get('counters').wall === this.model.get('wall').length)
						return;					
					
					var offset = this.model.get('wall').length;

					VK.loadWall(user.id, offset, _.bind(function(user){
						this.wall.render(user);
					}, this));
				} else {					
					// If photos completly loaded
					if (this.model.get('counters').photos === this.model.get('photos').length)
						return;					

					var offset = this.model.get('photos').length;

					VK.loadUserPhotos(user.id, offset, _.bind(function(user){
						this.renderPhotos(user);
					}, this));
				}
			}
		}, 1000)
	});


	var SidebarView = Backbone.View.extend({

		template: $('#user_sidebar_template').html(),


		initialize: function(){
			_.bindAll(this, "render");
		},


		render: function(user){
			if (App.opened_user != user.id) 
				return false;

			user = user.toJSON();
							
			var self = this;			
			var counters = user.counters;

			navigation = [				
				{ name:'Photos', count:counters.photos, url:"/photos" },
				{ name:'Videos', count:counters.videos },
				{ name:'Audio files', count:counters.audios }
			];

			if (VK.SESSION.user_id === user.id)
				navigation.splice(0, 0, { name: 'News', count:counters.news });

			// Remove items with zero count
			navigation = _.reject(navigation, function(i){ return !i.count });						


			var view = {
				'navigation': navigation,
				'user': user,

				'user_friends': _.first(user.friends, 6),
				'user_followers': _.first(user.followers, 6),

				'logged_user': user.id === VK.SESSION.user_id,
				'show_navigation': !!navigation.length,
				'show_friends': !!(user.friends && user.friends.length),
				'show_followers': !!(user.followers && user.followers.length),
			};

			output = $.mustache(this.template, view)			

			$('article aside').html(output);			
		}

	});


	var PhotoViewer = Backbone.View.extend({

		className: 'lightbox',
		

		initialize: function(start_element){
			this.render();
		},

		
		render: function(){
			var tmpl = "<a class='back'><</a>"+
					   "<a class='close'>X</a>"+
					   "<div class='window'></div>";

			this.el.innerHTML = tmpl;

			document.body.appendChild(this.el);
		}

	});
			

	var AppView = Backbone.View.extend({

		el: document.body,				

		events: {
			"click a[data-photo]": 'openPhoto'
		},

		
		initialize: function(){
			this.content = new ProfileView();
			this.sidebar = new SidebarView();
	
			this.render();
		},
			

		render: function(user){			
			var current_user, full_name;

			if (!(current_user = Users.get(VK.SESSION.user_id))) return;

			full_name = fullName(current_user.toJSON());

			$('body > nav .logo a').html(full_name);
		},

		openPhoto: function(evt){
			new PhotoViewer(evt.target);
		}

	});

	var App = new AppView();


	var AppRouter = Backbone.Router.extend({		

		routes: {
			"": "loadCurrentUser",
			"logged": "logged",
			"user/:user_id": "loadUser",
			"user/:user_id/photos": "loadUserPhotos"
		},


		logged: function(){
			//Removing this state from history
			if ('replaceState' in wnd.history)
				wnd.history.replaceState({},"","");

			VK.SESSION = store.get('session');			

			this.navigate("/user/" + VK.SESSION.user_id, true);
		},


		loadCurrentUser: function(){			
			if (VK.SESSION.access_token) {
				// Fixing history
				if ('replaceState' in wnd.history)
					wnd.history.replaceState({},"","#/user/"+VK.SESSION.user_id);

				this.navigate("/user/" + VK.SESSION.user_id, true);
			}
		},

		_loadUserCallback: function(user, callback) {
			// Turn off loading state
			document.body.className = "";

			if (App.opened_user == VK.SESSION.user_id) 
				App.render();

			if (callback) { 
				callback(user);
			} else {
				App.content.renderProfile(user);
				App.sidebar.render(user);										
			}
		},


		loadUser: function(user_id, callback){			
			if (!VK.SESSION.user_id) return;

			App.opened_user = parseInt(user_id);			

			document.body.className += " loading";

			// Loading from Cache to speedup UI. Uppdating data in background
			var cached_user = Users.get(user_id);						

			if (cached_user && cached_user.get('counters')) {
				this._loadUserCallback(cached_user, callback);
			}

			VK.loadProfile(user_id, _.bind(function(user) {
				this._loadUserCallback(user, callback);
			}, this));
		},


		loadUserPhotos: function(user_id, from_cache){
			this.loadUser(user_id, function(user){
				App.sidebar.render(user);
				App.content.renderPhotos(user);
			});
		}

	});

	var Router = new AppRouter();

	Backbone.history.start();

}).apply(this)
