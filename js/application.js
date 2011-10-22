(function(){ 
	var wnd = this;

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

		if (minutes <= 10) 
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


	/*
		Simple VK API wrapper
	*/
	var VK = {
		BASE_URL: "https://api.vkontakte.ru/method/",

		APP_ID: 2649785,
		SETTINGS: "notify,friends,photos,audio,video,docs,notes,pages,wall,groups",
		REDIRECT_URI: "http://localhost.com/vk_contest/",
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
				
				// Caching all groups and profiles
				_.each(resp.response.wall.groups, function(group){
					// If not cached
					if (!Groups.get(group.gid)) {
						group.id = group.gid;
						Groups.create(group);
					}					
				});

				_.each(resp.response.wall.profiles, function(profile){
					// If not cached
					if (!Users.get(profile.uid)) {
						profile.id = profile.uid;

						Users.create(profile);
					}
				});						
								
				var post_ids = _.map(user.wall, function(post){ return post.id });
				// Second request to get comments;
				VK.loadWallComments(user.id, post_ids);

				user = Users.create(user);						
				VK.trigger('user:loaded', user);
				
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
			console.log('loading comments');

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
						'comments': _.rest(comments)
					});
				});

				// Flattening array and removing nullable objects
				users = _.compact(_.flatten(resp.response.users));

				_.each(users, function(user){					
					// If not cached
					if (!Users.get(user.uid)) {
						user.id = user.uid;
																		
						Users.create(user);
					}					
				});				
				
				VK.trigger('user:wallLoaded', user);

				if (callback) 
					callback(user);
			});						
		}
	}	

	// Adding event emitter to VK module
	_.extend(VK, Backbone.Events);


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
		wnd.close();	
	}
	

	$('#login_button').bind('click', function(){		
		var url = ["http://api.vkontakte.ru/oauth/authorize?",			
	 			   "client_id=" + VK.APP_ID,
	 			   "scope=" + VK.SETTINGS,
	 			   "redirect_uri=" + VK.REDIRECT_URI,
	 			   "display=" + VK.DISPLAY,
	 			   "response_type=token"].join('&')

		var wnd = window.open(url, "auth_dialog", "menubar=0,resizable=0,width=1,height=1");			
	});	


	var AppView = Backbone.View.extend({
		el: document.body,		
		// Caching templates
		navigation_template: $('#user_sidebar_template').html(),
		profile_template: $('#user_profile_template').html(),
		user_wall_template: $('#user_wall_template').html(),

		events: {
			"click .wall .show_all": "loadComments"
		},

		initialize: function(){
			_.bindAll(this);

			VK.bind('user:loaded', this.render);
			VK.bind('user:wallLoaded', this.renderWall);
		},

		
		render: function(user){			
			if (this.opened_user != user.id) 
				return false;

			this.model = user;

			this.renderHeader();

			this.renderPanel();
			this.renderProfile();			
			this.renderWall();
		},


		renderHeader: function() {			
			var current_user, full_name;

			if (!(current_user = Users.get(VK.SESSION.user_id))) return;			

			full_name = fullName(current_user.toJSON());

			$('body > nav .logo a').html(full_name);
		},


		renderProfile: function() {
			user = this.model.toJSON();

			var view = {
				'user': this.model.toJSON(),

				'have_photos': !!user.photos.length,
				'user_photos': user.photos,
				
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
		},


		renderWall: function(user){
			if (user && this.opened_user != user.id) 
				return false;

			var self = this;

			// Because we can't load post comments among with userProfile, we displayng first level post messages, with comment stubs (only if post loaded first time), based on given count, and downloading rest of comments in background.			 			
			var wall = _.map(this.model.get('wall'), function(post){
				var comments;
				var cache = Posts.get(self.model.id+"_"+post.id);

				// Creating stubs if not found in cache
				if (!cache) {
					comments = _.range(post.comments.count);
					comments = comments.map(function(){ return { } });
					comments = _.first(comments, 3);
				} else {																	
					comments = cache.get('comments');										
					comments = _.sortBy(comments, function(c){ return c.date });

					if (!post.opened)
						comments = _.last(comments, 3);									
				}
			
				messages = _.union([post], comments);			

				return { 'messages': messages }
			});

			var view = {
				'posts': wall,
				'user': this.model.toJSON(),

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
				
					switch (this.type) {
						case 'image':
						case 'video':
							this.preview = this[this.type].image_small || this[this.type].src;
							tmpl = '<a href="#" class="{{type}}"><img src="{{preview}}"" /></a>';
							break;
					}				
									
					return $.mustache(tmpl, this);
				},

				'more_then_three_comments': function(){
					return this.comments && this.comments.count > 3;
				},

				'is_closed': function(){
					console.log(this.opened, this);

					return !this.opened;
				},
				
				'likes_count': function(){
					if (!this.likes) return 0;

					return this.likes.count === true ? 0 : this.likes.count;
				}
			};

			output = $.mustache(this.user_wall_template, view);

			$('article section.profile .wall').html(output);
		},


		renderPanel: function(){
			var self = this;
			var counters = this.model.get('counters');

			navigation = [				
				{ name:'Photos', count:counters.photos },
				{ name:'Videos', count:counters.videos },
				{ name:'Audio files', count:counters.audios }
			];

			if (VK.SESSION.user_id === this.model.id)
				navigation.splice(0, 0, { name: 'News', count:counters.news });

			// Remove items with zero count
			navigation = _.reject(navigation, function(i){ return !i.count });			

			var user = this.model.toJSON();

			var view = {
				'navigation': navigation,
				'user': user,

				'user_friends': _.first(user.friends, 6),
				'user_followers': _.first(user.followers, 6),

				'logged_user': this.model.id === VK.SESSION.user_id,
				'show_navigation': !!navigation.length,
				'show_friends': !!(user.friends && user.friends.length),
				'show_followers': !!(user.followers && user.followers.length),
			};

			output = $.mustache(this.navigation_template, view)

			$('article aside').html(output);
		},

		loadComments: function(evt){
			evt.target.innerHTML = 'Loading...';

			// data-post="#{user_id}_#{post_id}"
			var post_data = $(evt.target).attr('data-post').split('_');
			
			var post = _.detect(this.model.attributes.wall, function(item) {			
				return item.id === parseInt(post_data[1]);
			})
			post.opened = true;

			VK.loadWallComments(post_data[0], [post_data[1]], 0);
		}
	});

	var App = new AppView();

	var AppRouter = Backbone.Router.extend({		
		routes: {
			"": "loadCurrentUser",
			"logged": "logged",
			"user/:user_id": "loadUser"
		},

		logged: function(){
			//Removing this state from history
			if ('replaceState' in wnd.history)
				wnd.history.replaceState({},"","");

			VK.SESSION = store.get('session');
			this.navigate("/user/" + VK.SESSION.user_id);
		},

		loadCurrentUser: function(){
			if (VK.SESSION.access_token)
				this.navigate("/user/" + VK.SESSION.user_id);
		},

		loadUser: function(user_id) {
			var self = this;
			App.opened_user = parseInt(user_id);

			document.body.className += " loading";

			// Loading from Cache to speedup UI. Uppdating data in background
			var cached_user = Users.get(user_id);						

			if (cached_user && cached_user.get('counters')) {
				VK.trigger('user:loaded', cached_user);

				document.body.className = "";
			}

			VK.loadProfile(user_id, function(user){				
				// Turn off loading state
				document.body.className = "";
			});
		}

	});

	new AppRouter();
	Backbone.history.start();

}).apply(this)