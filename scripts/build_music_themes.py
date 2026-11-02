"""音楽版「テーマから選ぶ」の曲リスト（music_themes.json）を作る。

候補は (アーティスト, 曲名[, 作品メモ]) で手で選んだもの。iTunes（日本のストア）で「アーティスト 曲名」を検索し、
アーティスト名と曲名が合う曲を選ぶ（日本のストアで合わなければ米国ストアの名前で照合）。
同じ曲が複数あるときは itunes.py と同じ決まり（元のアルバム優先）で1つ選ぶ。見つからない曲は記録して外す。
Apple の回数制限に合わせて 1分あたり18回まで。取得結果は CACHE に保存し、再実行では使い回す。

  python3 scripts/build_music_themes.py            # music_themes.json を作る
"""
import hashlib, json, os, re, sys, time, unicodedata, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import itunes  # noqa: E402

CACHE = os.environ.get("THEMES_CACHE", "/tmp/tiari-themes-cache")
OUT = os.path.join(ROOT, "music_themes.json")
GAP = 60 / 18
_last = [0.0]

T = []  # (id, group, label, description, [(artist, title[, note])])


def theme(tid, group, label, desc, songs):
    T.append((tid, group, label, desc, songs))


theme("y70", "年代", "70年代ヒット", "フォーク・歌謡曲・ニューミュージックの名曲", [
    ("吉田拓郎", "結婚しようよ"), ("井上陽水", "夢の中へ"), ("かぐや姫", "神田川"), ("小坂明子", "あなた"),
    ("太田裕美", "木綿のハンカチーフ"), ("荒井由実", "あの日にかえりたい"), ("荒井由実", "ルージュの伝言"),
    ("子門真人", "およげ!たいやきくん"), ("山口百恵", "横須賀ストーリー"), ("山口百恵", "プレイバックPart2"),
    ("ピンク・レディー", "UFO"), ("ピンク・レディー", "ペッパー警部"), ("ピンク・レディー", "サウスポー"),
    ("キャンディーズ", "春一番"), ("キャンディーズ", "微笑がえし"), ("沢田研二", "勝手にしやがれ"),
    ("沢田研二", "時の過ぎゆくままに"), ("都はるみ", "北の宿から"), ("石川さゆり", "津軽海峡・冬景色"),
    ("サザンオールスターズ", "勝手にシンドバッド"), ("サザンオールスターズ", "いとしのエリー"),
    ("ゴダイゴ", "ガンダーラ"), ("ゴダイゴ", "モンキー・マジック"), ("西城秀樹", "YOUNG MAN"),
    ("渡辺真知子", "かもめが翔んだ日"), ("中島みゆき", "わかれうた"), ("中島みゆき", "時代"),
    ("世良公則&ツイスト", "銃爪"), ("庄野真代", "飛んでイスタンブール"), ("久保田早紀", "異邦人"),
    ("アリス", "チャンピオン"), ("松山千春", "季節の中で"), ("さだまさし", "関白宣言"), ("岩崎宏美", "ロマンス"),
    ("南沙織", "17才"), ("小柳ルミ子", "瀬戸の花嫁"), ("ガロ", "学生街の喫茶店"), ("チューリップ|TULIP", "心の旅"),
    ("布施明", "シクラメンのかほり"), ("郷ひろみ", "よろしく哀愁"), ("尾崎紀世彦", "また逢う日まで"),
    ("八神純子", "みずいろの雨"), ("大橋純子", "たそがれマイ・ラブ"), ("桜田淳子", "わたしの青い鳥"),
])

theme("y80", "年代", "80年代ヒット", "アイドル黄金期とバンドブームの名曲", [
    ("松田聖子", "赤いスイートピー"), ("松田聖子", "青い珊瑚礁"), ("中森明菜", "少女A"), ("中森明菜", "DESIRE"),
    ("中森明菜", "飾りじゃないのよ涙は"), ("寺尾聰", "ルビーの指環"), ("薬師丸ひろ子", "セーラー服と機関銃"),
    ("大滝詠一", "君は天然色"), ("杏里", "CAT'S EYE"), ("安全地帯", "ワインレッドの心"), ("安全地帯", "恋の予感"),
    ("チェッカーズ", "ギザギザハートの子守唄"), ("チェッカーズ", "涙のリクエスト"),
    ("小泉今日子", "なんてったってアイドル"), ("吉川晃司", "モニカ"), ("REBECCA", "フレンズ"),
    ("BOØWY", "マリオネット"), ("渡辺美里", "My Revolution"), ("TM NETWORK", "Get Wild"),
    ("光GENJI", "パラダイス銀河"), ("長渕剛", "乾杯"), ("中島みゆき", "悪女"), ("松任谷由実", "守ってあげたい"),
    ("尾崎豊", "15の夜"), ("少年隊", "仮面舞踏会"), ("工藤静香", "恋一夜"), ("荻野目洋子", "ダンシング・ヒーロー"),
    ("C-C-B", "Romanticが止まらない"), ("斉藤由貴", "卒業"), ("あみん", "待つわ"), ("竹内まりや", "駅"),
    ("Wink", "淋しい熱帯魚"), ("PRINCESS PRINCESS|プリンセス プリンセス", "Diamonds"), ("PRINCESS PRINCESS|プリンセス プリンセス", "M"),
    ("爆風スランプ", "Runner"), ("徳永英明", "レイニー ブルー"), ("小林明子", "恋におちて"),
    ("中村あゆみ", "翼の折れたエンジェル"), ("大沢誉志幸", "そして僕は途方に暮れる"), ("美空ひばり", "川の流れのように"),
    ("THE BLUE HEARTS", "リンダ リンダ"), ("近藤真彦", "ギンギラギンにさりげなく"),
])

theme("y90", "年代", "90年代ヒット", "ミリオンセラーが続いたCD全盛期の名曲", [
    ("B.B.クィーンズ", "おどるポンポコリン"), ("KAN", "愛は勝つ"), ("小田和正", "ラブ・ストーリーは突然に"),
    ("CHAGE and ASKA|CHAGE&ASKA", "SAY YES"), ("CHAGE and ASKA|CHAGE&ASKA", "YAH YAH YAH"),
    ("槇原敬之", "どんなときも。"), ("米米CLUB", "君がいるだけで"), ("大事MANブラザーズバンド", "それが大事"),
    ("ZARD", "負けないで"), ("ZARD", "揺れる想い"), ("B'z", "LOVE PHANTOM"),
    ("B'z", "愛のままにわがままに 僕は君だけを傷つけない"), ("DREAMS COME TRUE", "LOVE LOVE LOVE"),
    ("Mr.Children", "innocent world"), ("Mr.Children", "Tomorrow never knows"), ("Mr.Children", "名もなき詩"),
    ("globe", "DEPARTURES"), ("安室奈美恵", "CAN YOU CELEBRATE?"), ("trf", "EZ DO DANCE"),
    ("H Jungle with t", "WOW WAR TONIGHT"), ("華原朋美", "I'm proud"), ("スピッツ", "ロビンソン"),
    ("スピッツ", "空も飛べるはず"), ("スピッツ", "チェリー"), ("SMAP", "夜空ノムコウ"), ("GLAY", "HOWEVER"),
    ("GLAY", "Winter,again"), ("L'Arc〜en〜Ciel|L'Arc-en-Ciel", "HONEY"), ("宇多田ヒカル", "Automatic"),
    ("宇多田ヒカル", "First Love"), ("広瀬香美", "ロマンスの神様"), ("WANDS", "世界が終るまでは…"),
    ("大黒摩季", "ら・ら・ら"), ("久保田利伸", "LA・LA・LA LOVE SONG"), ("藤井フミヤ", "TRUE LOVE"),
    ("福山雅治", "HELLO"), ("浜崎あゆみ", "Boys & Girls"), ("モーニング娘。", "LOVEマシーン"),
    ("椎名林檎", "ここでキスして。"), ("Every Little Thing", "Time goes by"), ("SPEED", "White Love"),
    ("JUDY AND MARY", "そばかす"), ("相川七瀬", "夢見る少女じゃいられない"), ("ウルフルズ", "ガッツだぜ!!"),
    ("岡本真夜", "TOMORROW"), ("X JAPAN", "Forever Love"),
])

theme("y00", "年代", "2000年代ヒット", "J-POPの定番が次々に生まれた00年代", [
    ("サザンオールスターズ", "TSUNAMI"), ("MISIA", "Everything"), ("福山雅治", "桜坂"), ("浜崎あゆみ", "SEASONS"),
    ("宇多田ヒカル", "traveling"), ("宇多田ヒカル", "COLORS"), ("B'z", "ultra soul"), ("ケツメイシ", "さくら"),
    ("平井堅", "瞳をとじて"), ("森山直太朗", "さくら(独唱)"), ("SMAP", "世界に一つだけの花"), ("中島美嘉", "雪の華"),
    ("ORANGE RANGE", "花"), ("ORANGE RANGE", "上海ハニー"), ("一青窈", "ハナミズキ"), ("コブクロ", "桜"),
    ("コブクロ", "蕾"), ("mihimaru GT", "気分上々↑↑"), ("Mr.Children", "Sign"), ("Mr.Children", "しるし"),
    ("GReeeeN", "キセキ"), ("GReeeeN", "愛唄"), ("秋川雅史", "千の風になって"), ("絢香", "三日月"),
    ("いきものがかり", "SAKURA"), ("いきものがかり", "ブルーバード"), ("青山テルマ", "そばにいるね"),
    ("Perfume", "ポリリズム"), ("嵐", "Love so sweet"), ("EXILE", "Ti Amo"), ("倖田來未", "キューティーハニー"),
    ("大塚愛", "さくらんぼ"), ("RIP SLYME", "楽園ベイベー"), ("修二と彰", "青春アミーゴ"), ("木村カエラ", "Butterfly"),
    ("レミオロメン", "粉雪"), ("スキマスイッチ", "全力少年"), ("スキマスイッチ", "奏(かなで)"),
    ("BUMP OF CHICKEN", "天体観測"), ("夏川りみ", "涙そうそう"), ("中島みゆき", "地上の星"),
    ("アンジェラ・アキ", "手紙 〜拝啓 十五の君へ〜"), ("YUI", "CHE.R.RY"), ("AKB48", "RIVER"),
    ("Superfly", "愛をこめて花束を"),
])

theme("y10", "年代", "2010年代ヒット", "配信とSNSから広がった10年代の名曲", [
    ("いきものがかり", "ありがとう"), ("植村花菜", "トイレの神様"), ("西野カナ", "会いたくて 会いたくて"),
    ("AKB48", "ヘビーローテーション"), ("AKB48", "恋するフォーチュンクッキー"), ("きゃりーぱみゅぱみゅ", "PONPONPON"),
    ("星野源", "恋"), ("星野源", "SUN"), ("三代目 J SOUL BROTHERS from EXILE TRIBE|三代目 J Soul Brothers", "R.Y.U.S.E.I."),
    ("松たか子", "レット・イット・ゴー〜ありのままで〜"), ("back number", "クリスマスソング"),
    ("back number", "高嶺の花子さん"), ("SEKAI NO OWARI", "RPG"), ("SEKAI NO OWARI", "Dragon Night"),
    ("RADWIMPS", "前前前世"), ("米津玄師", "Lemon"), ("DAOKO|米津玄師", "打上花火"),
    ("欅坂46", "サイレントマジョリティー"), ("乃木坂46", "インフルエンサー"), ("DA PUMP", "U.S.A."),
    ("あいみょん", "マリーゴールド"), ("King Gnu", "白日"), ("Official髭男dism", "Pretender"), ("Foorin", "パプリカ"),
    ("菅田将暉", "さよならエレジー"), ("菅田将暉", "まちがいさがし"), ("ONE OK ROCK", "The Beginning"),
    ("宇多田ヒカル", "花束を君に"), ("安室奈美恵", "Hero"), ("西野カナ", "トリセツ"), ("秦基博", "ひまわりの約束"),
    ("LiSA", "紅蓮華"), ("嵐", "Troublemaker"), ("Mrs. GREEN APPLE", "青と夏"), ("サカナクション", "新宝島"),
    ("[Alexandros]", "ワタリドリ"), ("星野源", "アイデア"), ("Perfume", "チョコレイト・ディスコ"),
    ("平井堅", "ノンフィクション"), ("ゴールデンボンバー", "女々しくて"),
])

theme("y20", "年代", "2020年代ヒット", "ストリーミングとTikTok時代のヒット曲", [
    ("YOASOBI", "夜に駆ける"), ("YOASOBI", "アイドル"), ("YOASOBI", "群青"), ("LiSA", "炎"), ("瑛人", "香水"),
    ("Official髭男dism", "I LOVE..."), ("Official髭男dism", "Subtitle"), ("Official髭男dism", "ミックスナッツ"),
    ("優里", "ドライフラワー"), ("優里", "ベテルギウス"), ("Ado", "うっせぇわ"), ("Ado", "新時代"),
    ("NiziU", "Make you happy"), ("Creepy Nuts", "Bling-Bang-Bang-Born"), ("Creepy Nuts", "オトノケ"),
    ("Mrs. GREEN APPLE", "ケセラセラ"), ("Mrs. GREEN APPLE", "ライラック"), ("Mrs. GREEN APPLE", "ダンスホール"),
    ("Vaundy", "怪獣の花唄"), ("King Gnu", "一途"), ("King Gnu", "SPECIALZ"), ("米津玄師", "KICK BACK"),
    ("米津玄師", "感電"), ("米津玄師", "M八七"), ("back number", "水平線"), ("あいみょん", "裸の心"),
    ("Tani Yuuki", "W/X/Y"), ("Saucy Dog", "シンデレラボーイ"), ("なとり", "Overdose"), ("imase", "NIGHT DANCER"),
    ("藤井風", "死ぬのがいいわ"), ("藤井風", "きらり"), ("緑黄色社会", "Mela!"), ("SEKAI NO OWARI", "Habit"),
    ("Number_i", "GOAT"), ("tuki.", "晩餐歌"), ("こっちのけんと", "はいよろこんで"),
    ("新しい学校のリーダーズ", "オトナブルー"), ("Aimer", "残響散歌"), ("Eve", "廻廻奇譚"),
])

theme("drama", "シーン", "ドラマ主題歌", "ドラマとともに記憶に残る主題歌", [
    ("小田和正", "ラブ・ストーリーは突然に", "ドラマ『東京ラブストーリー』"),
    ("CHAGE and ASKA|CHAGE&ASKA", "SAY YES", "ドラマ『101回目のプロポーズ』"),
    ("米米CLUB", "君がいるだけで", "ドラマ『素顔のままで』"),
    ("藤井フミヤ", "TRUE LOVE", "ドラマ『あすなろ白書』"),
    ("松任谷由実", "真夏の夜の夢", "ドラマ『誰にも言えない』"),
    ("久保田利伸", "LA・LA・LA LOVE SONG", "ドラマ『ロングバケーション』"),
    ("宇多田ヒカル", "First Love", "ドラマ『魔女の条件』"),
    ("嵐", "Love so sweet", "ドラマ『花より男子2（リターンズ）』"),
    ("宇多田ヒカル", "花束を君に", "連続テレビ小説『とと姉ちゃん』"),
    ("星野源", "恋", "ドラマ『逃げるは恥だが役に立つ』"),
    ("米津玄師", "Lemon", "ドラマ『アンナチュラル』"),
    ("米津玄師", "感電", "ドラマ『MIU404』"),
    ("米津玄師", "Pale Blue", "ドラマ『リコカツ』"),
    ("Official髭男dism", "I LOVE...", "ドラマ『恋はつづくよどこまでも』"),
    ("Official髭男dism", "Subtitle", "ドラマ『silent』"),
    ("優里", "ベテルギウス", "ドラマ『SUPER RICH』"),
    ("あいみょん", "裸の心", "ドラマ『私の家政夫ナギサさん』"),
    ("菅田将暉", "まちがいさがし", "ドラマ『パーフェクトワールド』"),
    ("MISIA", "Everything", "ドラマ『やまとなでしこ』"),
    ("レミオロメン", "粉雪", "ドラマ『1リットルの涙』"),
    ("修二と彰", "青春アミーゴ", "ドラマ『野ブタ。をプロデュース』"),
    ("いきものがかり", "ありがとう", "連続テレビ小説『ゲゲゲの女房』"),
    ("Mr.Children", "Tomorrow never knows", "ドラマ『若者のすべて』"),
    ("Mr.Children", "名もなき詩", "ドラマ『ピュア』"),
    ("Mr.Children", "しるし", "ドラマ『14才の母』"),
    ("スピッツ", "空も飛べるはず", "ドラマ『白線流し』"),
    ("SMAP", "夜空ノムコウ", "ドラマ『ソムリエ』"),
    ("SMAP", "世界に一つだけの花", "ドラマ『僕の生きる道』"),
    ("Every Little Thing", "Time goes by", "ドラマ『甘い結婚』"),
    ("安室奈美恵", "CAN YOU CELEBRATE?", "ドラマ『バージンロード』"),
    ("DREAMS COME TRUE", "LOVE LOVE LOVE", "ドラマ『愛していると言ってくれ』"),
    ("back number", "クリスマスソング", "ドラマ『5→9〜私に恋したお坊さん〜』"),
    ("King Gnu", "白日", "ドラマ『イノセンス 冤罪弁護士』"),
    ("Mrs. GREEN APPLE", "ケセラセラ", "ドラマ『日曜の夜ぐらいは...』"),
    ("宇多田ヒカル", "君に夢中", "ドラマ『最愛』"),
    ("星野源", "SUN", "ドラマ『心がポキッとね』"),
    ("星野源", "アイデア", "連続テレビ小説『半分、青い。』"),
    ("Superfly", "愛をこめて花束を", "ドラマ『エジソンの母』"),
    ("小林明子", "恋におちて", "ドラマ『金曜日の妻たちへIII 恋におちて』"),
    ("中島みゆき", "空と君のあいだに", "ドラマ『家なき子』"),
    ("浜田省吾", "悲しみは雪のように", "ドラマ『愛という名のもとに』"),
    ("平井堅", "ノンフィクション", "ドラマ『小さな巨人』"),
])

theme("anime", "シーン", "アニメ主題歌", "テレビアニメ・アニメ映画の主題歌", [
    ("ささきいさお", "宇宙戦艦ヤマト", "アニメ『宇宙戦艦ヤマト』"),
    ("杏里", "CAT'S EYE", "アニメ『キャッツ・アイ』"),
    ("B.B.クィーンズ", "おどるポンポコリン", "アニメ『ちびまる子ちゃん』"),
    ("高橋洋子", "残酷な天使のテーゼ", "アニメ『新世紀エヴァンゲリオン』"),
    ("影山ヒロノブ", "CHA-LA HEAD-CHA-LA", "アニメ『ドラゴンボールZ』"),
    ("TM NETWORK", "Get Wild", "アニメ『シティーハンター』"),
    ("きただにひろし", "ウィーアー!", "アニメ『ONE PIECE』"),
    ("ZARD", "運命のルーレット廻して", "アニメ『名探偵コナン』"),
    ("ポルノグラフィティ", "メリッサ", "アニメ『鋼の錬金術師』"),
    ("ASIAN KUNG-FU GENERATION", "リライト", "アニメ『鋼の錬金術師』"),
    ("L'Arc〜en〜Ciel|L'Arc-en-Ciel", "READY STEADY GO", "アニメ『鋼の錬金術師』"),
    ("いきものがかり", "ブルーバード", "アニメ『NARUTO -ナルト- 疾風伝』"),
    ("FLOW", "GO!!!", "アニメ『NARUTO -ナルト-』"),
    ("UVERworld", "D-tecnoLife", "アニメ『BLEACH』"),
    ("坂本真綾", "プラチナ", "アニメ『カードキャプターさくら』"),
    ("Linked Horizon", "紅蓮の弓矢", "アニメ『進撃の巨人』"),
    ("LiSA", "紅蓮華", "アニメ『鬼滅の刃』"),
    ("LiSA", "炎", "映画『劇場版「鬼滅の刃」無限列車編』"),
    ("LiSA", "crossing field", "アニメ『ソードアート・オンライン』"),
    ("藍井エイル", "IGNITE", "アニメ『ソードアート・オンラインII』"),
    ("Aimer", "残響散歌", "アニメ『鬼滅の刃』遊郭編"),
    ("RADWIMPS", "前前前世", "映画『君の名は。』"),
    ("米津玄師", "KICK BACK", "アニメ『チェンソーマン』"),
    ("米津玄師", "ピースサイン", "アニメ『僕のヒーローアカデミア』"),
    ("YOASOBI", "アイドル", "アニメ『【推しの子】』"),
    ("YOASOBI", "祝福", "アニメ『機動戦士ガンダム 水星の魔女』"),
    ("YOASOBI", "勇者", "アニメ『葬送のフリーレン』"),
    ("King Gnu", "一途", "映画『劇場版 呪術廻戦 0』"),
    ("King Gnu", "SPECIALZ", "アニメ『呪術廻戦』"),
    ("Eve", "廻廻奇譚", "アニメ『呪術廻戦』"),
    ("Official髭男dism", "Cry Baby", "アニメ『東京リベンジャーズ』"),
    ("Official髭男dism", "ミックスナッツ", "アニメ『SPY×FAMILY』"),
    ("Creepy Nuts", "Bling-Bang-Bang-Born", "アニメ『マッシュル-MASHLE-』"),
    ("Creepy Nuts", "オトノケ", "アニメ『ダンダダン』"),
    ("Ado", "新時代", "映画『ONE PIECE FILM RED』"),
    ("結束バンド", "青春コンプレックス", "アニメ『ぼっち・ざ・ろっく!』"),
    ("Mrs. GREEN APPLE", "ライラック", "アニメ『忘却バッテリー』"),
    ("井上あずみ", "君をのせて", "映画『天空の城ラピュタ』"),
    ("井上あずみ", "さんぽ", "映画『となりのトトロ』"),
    ("荒井由実", "やさしさに包まれたなら", "映画『魔女の宅急便』"),
])

theme("movie", "シーン", "映画主題歌", "邦画・洋画・アニメ映画の主題歌", [
    ("薬師丸ひろ子", "セーラー服と機関銃", "映画『セーラー服と機関銃』"),
    ("薬師丸ひろ子", "Woman", "映画『Wの悲劇』"),
    ("原田知世", "時をかける少女", "映画『時をかける少女』"),
    ("ゴダイゴ", "銀河鉄道999", "映画『銀河鉄道999』"),
    ("槇原敬之", "どんなときも。", "映画『就職戦線異状なし』"),
    ("平井堅", "瞳をとじて", "映画『世界の中心で、愛をさけぶ』"),
    ("中島美嘉", "GLAMOROUS SKY", "映画『NANA』"),
    ("YUI", "Good-bye days", "映画『タイヨウのうた』"),
    ("KOH+", "最愛", "映画『容疑者Xの献身』"),
    ("秦基博", "ひまわりの約束", "映画『STAND BY ME ドラえもん』"),
    ("RADWIMPS", "前前前世", "映画『君の名は。』"),
    ("RADWIMPS", "愛にできることはまだあるかい", "映画『天気の子』"),
    ("RADWIMPS", "すずめ", "映画『すずめの戸締まり』"),
    ("DAOKO|米津玄師", "打上花火", "映画『打ち上げ花火、下から見るか？横から見るか？』"),
    ("米津玄師", "地球儀", "映画『君たちはどう生きるか』"),
    ("米津玄師", "M八七", "映画『シン・ウルトラマン』"),
    ("宇多田ヒカル", "One Last Kiss", "映画『シン・エヴァンゲリオン劇場版』"),
    ("宇多田ヒカル", "Beautiful World", "映画『ヱヴァンゲリヲン新劇場版：序』"),
    ("Official髭男dism", "Pretender", "映画『コンフィデンスマンJP ロマンス編』"),
    ("松たか子", "レット・イット・ゴー〜ありのままで〜", "映画『アナと雪の女王』"),
    ("荒井由実", "ひこうき雲", "映画『風立ちぬ』"),
    ("中島みゆき", "糸", "映画『糸』"),
    ("Ado", "新時代", "映画『ONE PIECE FILM RED』"),
    ("LiSA", "炎", "映画『劇場版「鬼滅の刃」無限列車編』"),
    ("back number", "ハッピーエンド", "映画『ぼくは明日、昨日のきみとデートする』"),
    ("back number", "瞬き", "映画『8年越しの花嫁 奇跡の実話』"),
    ("あいみょん", "ハルノヒ", "映画『クレヨンしんちゃん 新婚旅行ハリケーン〜失われたひろし〜』"),
    ("星野源", "ドラえもん", "映画『ドラえもん のび太の宝島』"),
    ("Mrs. GREEN APPLE", "青と夏", "映画『青夏 きみに恋した30日』"),
    ("Celine Dion|セリーヌ・ディオン", "My Heart Will Go On", "映画『タイタニック』"),
    ("Whitney Houston|ホイットニー・ヒューストン", "I Will Always Love You", "映画『ボディガード』"),
    ("Kenny Loggins|ケニー・ロギンス", "Footloose", "映画『フットルース』"),
    ("Irene Cara|アイリーン・キャラ", "Flashdance... What a Feeling", "映画『フラッシュダンス』"),
    ("Survivor|サバイバー", "Eye of the Tiger", "映画『ロッキー3』"),
    ("Ray Parker Jr.|レイ・パーカー・ジュニア", "Ghostbusters", "映画『ゴーストバスターズ』"),
    ("Huey Lewis & The News|ヒューイ・ルイス&ザ・ニュース", "The Power of Love", "映画『バック・トゥ・ザ・フューチャー』"),
    ("Pharrell Williams|ファレル・ウィリアムス", "Happy", "映画『怪盗グルーのミニオン危機一発』"),
    ("Lady Gaga|レディー・ガガ", "Shallow", "映画『アリー/ スター誕生』"),
    ("Ben E. King|ベン・E・キング", "Stand by Me", "映画『スタンド・バイ・ミー』"),
])

theme("graduation", "シーン", "卒業ソング", "旅立ちの季節に聴きたい定番曲", [
    ("森山直太朗", "さくら(独唱)"), ("斉藤由貴", "卒業"), ("尾崎豊", "卒業"), ("荒井由実", "卒業写真"),
    ("海援隊", "贈る言葉"), ("柏原芳恵", "春なのに"), ("H2O", "想い出がいっぱい"), ("レミオロメン", "3月9日"),
    ("コブクロ", "桜"), ("いきものがかり", "YELL"), ("アンジェラ・アキ", "手紙 〜拝啓 十五の君へ〜"),
    ("川嶋あい", "旅立ちの日に…"), ("ZONE", "secret base 〜君がくれたもの〜"), ("EXILE", "道"),
    ("GReeeeN", "遥か"), ("中島みゆき", "時代"), ("長渕剛", "乾杯"), ("SMAP", "世界に一つだけの花"),
    ("ゆず", "栄光の架橋"), ("Kiroro", "未来へ"), ("AKB48", "桜の木になろう"), ("いきものがかり", "SAKURA"),
    ("Mr.Children", "旅立ちの唄"), ("Mrs. GREEN APPLE", "僕のこと"),
    ("松田聖子", "制服"),
])

theme("summer", "シーン", "夏うた", "海・花火・夏休みを感じる曲", [
    ("サザンオールスターズ", "真夏の果実"), ("サザンオールスターズ", "希望の轍"),
    ("サザンオールスターズ", "勝手にシンドバッド"), ("TUBE", "シーズン・イン・ザ・サン"), ("TUBE", "あー夏休み"),
    ("TUBE", "夏を抱きしめて"), ("井上陽水", "少年時代"), ("ZONE", "secret base 〜君がくれたもの〜"),
    ("ORANGE RANGE", "ロコローション"), ("ケツメイシ", "夏の思い出"), ("class", "夏の日の1993"),
    ("JITTERIN'JINN|ジッタリン・ジン", "夏祭り"), ("Whiteberry", "夏祭り"), ("松田聖子", "青い珊瑚礁"),
    ("大滝詠一", "君は天然色"), ("杉山清貴&オメガトライブ", "ふたりの夏物語"), ("湘南乃風", "睡蓮花"),
    ("松任谷由実", "真夏の夜の夢"), ("フジファブリック", "若者のすべて"), ("RIP SLYME", "楽園ベイベー"),
    ("DAOKO|米津玄師", "打上花火"), ("Mrs. GREEN APPLE", "青と夏"), ("aiko", "花火"),
    ("ポルノグラフィティ", "アゲハ蝶"), ("ピンク・レディー", "渚のシンドバッド"), ("ゆず", "夏色"),
    ("大黒摩季", "夏が来る"), ("サザンオールスターズ", "TSUNAMI"), ("井上陽水|安全地帯", "夏の終わりのハーモニー"),
    ("山下達郎", "さよなら夏の日"), ("Def Tech", "My Way"),
])

theme("christmas", "シーン", "クリスマスソング", "冬の街に流れる邦楽・洋楽のクリスマス曲", [
    ("山下達郎", "クリスマス・イブ"), ("稲垣潤一", "クリスマスキャロルの頃には"),
    ("松任谷由実", "恋人がサンタクロース"), ("B'z", "いつかのメリークリスマス"), ("back number", "クリスマスソング"),
    ("辛島美登里", "サイレント・イヴ"), ("BoA", "メリクリ"), ("竹内まりや", "すてきなホリデイ"),
    ("Mariah Carey|マライア・キャリー", "All I Want for Christmas Is You"), ("Wham!|ワム!", "Last Christmas"),
    ("John Lennon|ジョン・レノン|Yoko Ono", "Happy Xmas (War Is Over)"), ("Bing Crosby|ビング・クロスビー", "White Christmas"),
    ("Band Aid|バンド・エイド", "Do They Know It's Christmas?"),
    ("Michael Bublé|マイケル・ブーブレ", "It's Beginning to Look a Lot Like Christmas"),
    ("Ariana Grande|アリアナ・グランデ", "Santa Tell Me"), ("Justin Bieber|ジャスティン・ビーバー", "Mistletoe"),
    ("Brenda Lee|ブレンダ・リー", "Rockin' Around the Christmas Tree"), ("Bobby Helms|ボビー・ヘルムス", "Jingle Bell Rock"),
    ("Paul McCartney|ポール・マッカートニー", "Wonderful Christmastime"), ("Chris Rea|クリス・レア", "Driving Home for Christmas"),
    ("Kelly Clarkson|ケリー・クラークソン", "Underneath the Tree"), ("Sia|シーア", "Snowman"),
    ("Carpenters|カーペンターズ", "Merry Christmas Darling"), ("Nat King Cole|ナット・キング・コール", "The Christmas Song"),
    ("Elvis Presley|エルヴィス・プレスリー", "Blue Christmas"), ("Dean Martin|ディーン・マーティン", "Let It Snow! Let It Snow! Let It Snow!"),
    ("José Feliciano|ホセ・フェリシアーノ", "Feliz Navidad"), ("Andy Williams|アンディ・ウィリアムス", "It's the Most Wonderful Time of the Year"),
    ("Darlene Love|ダーレン・ラヴ", "Christmas (Baby Please Come Home)"), ("Jackson 5|ジャクソン5|ジャクソン・ファイヴ", "Santa Claus Is Coming to Town"),
])

theme("rock", "ジャンル", "ロック", "時代を代表する日本のロックバンドの名曲", [
    ("THE BLUE HEARTS", "リンダ リンダ"), ("THE BLUE HEARTS", "TRAIN-TRAIN"), ("BOØWY", "B・BLUE"),
    ("X JAPAN", "紅"), ("LUNA SEA", "ROSIER"), ("GLAY", "誘惑"), ("L'Arc〜en〜Ciel|L'Arc-en-Ciel", "Driver's High"),
    ("B'z", "ultra soul"), ("Mr.Children", "innocent world"), ("スピッツ", "ロビンソン"), ("JUDY AND MARY", "そばかす"),
    ("THEE MICHELLE GUN ELEPHANT", "世界の終わり"), ("くるり", "ばらの花"), ("NUMBER GIRL", "透明少女"),
    ("BUMP OF CHICKEN", "天体観測"), ("ASIAN KUNG-FU GENERATION", "リライト"), ("ELLEGARDEN", "ジターバグ"),
    ("ONE OK ROCK", "完全感覚Dreamer"), ("サカナクション", "新宝島"), ("[Alexandros]", "ワタリドリ"),
    ("back number", "高嶺の花子さん"), ("King Gnu", "白日"), ("WANIMA", "ともに"), ("10-FEET", "第ゼロ感"),
    ("マキシマム ザ ホルモン", "恋のメガラバ"), ("MONGOL800", "小さな恋のうた"), ("東京事変", "群青日和"),
    ("エレファントカシマシ", "今宵の月のように"), ("ウルフルズ", "ガッツだぜ!!"), ("ユニコーン", "大迷惑"),
    ("RCサクセション", "雨あがりの夜空に"), ("THE YELLOW MONKEY", "JAM"), ("ポルノグラフィティ", "アポロ"),
    ("フジファブリック", "若者のすべて"), ("Hi-STANDARD", "STAY GOLD"), ("Saucy Dog", "シンデレラボーイ"),
    ("マカロニえんぴつ", "なんでもないよ、"), ("RADWIMPS", "いいんですか?"), ("結束バンド", "青春コンプレックス"),
])

theme("idol", "ジャンル", "アイドル", "昭和から令和までのアイドルソング", [
    ("松田聖子", "赤いスイートピー"), ("中森明菜", "少女A"), ("小泉今日子", "なんてったってアイドル"),
    ("ピンク・レディー", "UFO"), ("キャンディーズ", "春一番"), ("おニャン子クラブ", "セーラー服を脱がさないで"),
    ("光GENJI", "パラダイス銀河"), ("少年隊", "仮面舞踏会"), ("Wink", "淋しい熱帯魚"), ("SMAP", "夜空ノムコウ"),
    ("モーニング娘。", "LOVEマシーン"), ("モーニング娘。", "恋愛レボリューション21"),
    ("松浦亜弥", "Yeah! めっちゃホリディ"), ("嵐", "A・RA・SHI"), ("嵐", "Love so sweet"), ("KinKi Kids", "硝子の少年"),
    ("TOKIO", "宙船"), ("AKB48", "ヘビーローテーション"), ("AKB48", "恋するフォーチュンクッキー"),
    ("ももいろクローバーZ", "行くぜっ!怪盗少女"), ("Perfume", "チョコレイト・ディスコ"), ("乃木坂46", "インフルエンサー"),
    ("乃木坂46", "君の名は希望"), ("欅坂46", "サイレントマジョリティー"), ("BABYMETAL", "ギミチョコ!!"),
    ("日向坂46", "キュン"), ("King & Prince", "シンデレラガール"), ("SixTONES", "Imitation Rain"), ("Number_i", "GOAT"),
    ("NiziU", "Make you happy"), ("FRUITS ZIPPER", "わたしの一番かわいいところ"), ("郷ひろみ", "GOLDFINGER'99"),
    ("田原俊彦", "哀愁でいと"), ("近藤真彦", "ギンギラギンにさりげなく"), ("西城秀樹", "YOUNG MAN"),
    ("SPEED", "White Love"), ("中森明菜", "DESIRE"),
])

theme("hiphop", "ジャンル", "ヒップホップ", "日本語ラップの定番とヒット曲", [
    ("スチャダラパー|小沢健二", "今夜はブギー・バック"), ("EAST END×YURI|EAST END", "DA.YO.NE"),
    ("KICK THE CAN CREW", "マルシェ"), ("KICK THE CAN CREW", "アンバランス"), ("RIP SLYME", "楽園ベイベー"),
    ("Dragon Ash", "Grateful Days"), ("ケツメイシ", "さくら"), ("m-flo", "come again"), ("KREVA", "音色"),
    ("SOUL'd OUT", "ウェカピポ"), ("Def Tech", "My Way"), ("nobodyknows+", "ヒロイズム"), ("RHYMESTER", "B-BOYイズム"),
    ("Creepy Nuts", "Bling-Bang-Bang-Born"), ("Creepy Nuts", "よふかしのうた"), ("Awich", "Queendom"),
    ("ちゃんみな", "Never Grow Up"), ("青山テルマ", "そばにいるね"), ("SEAMO", "マタアイマショウ"),
    ("千葉雄喜", "チーム友達"), ("BAD HOP", "Kawasaki Drift"), ("Zeebra", "Street Dreams"),
])

theme("citypop", "ジャンル", "シティポップ", "70〜80年代の都会的なポップスと、その流れをくむ曲", [
    ("竹内まりや", "プラスティック・ラブ"), ("竹内まりや", "SEPTEMBER"), ("松原みき", "真夜中のドア〜stay with me"),
    ("山下達郎", "RIDE ON TIME"), ("山下達郎", "SPARKLE"), ("大貫妙子", "都会"), ("大貫妙子", "4:00A.M."),
    ("杏里", "悲しみがとまらない"), ("大滝詠一", "君は天然色"), ("大滝詠一", "恋するカレン"), ("寺尾聰", "ルビーの指環"),
    ("南佳孝", "スローなブギにしてくれ"), ("杉山清貴&オメガトライブ", "ふたりの夏物語"),
    ("亜蘭知子", "Midnight Pretenders"), ("中原めいこ", "君たちキウイ・パパイア・マンゴーだね。"),
    ("八神純子", "みずいろの雨"), ("泰葉", "フライディ・チャイナタウン"), ("稲垣潤一", "ドラマティック・レイン"),
    ("荒井由実", "中央フリーウェイ"), ("大橋純子", "たそがれマイ・ラブ"), ("Suchmos", "STAY TUNE"),
    ("角松敏生", "SEA LINE"), ("吉田美奈子", "頬に夜の灯"), ("菊池桃子", "Mystical Composer"),
    ("山下達郎", "クリスマス・イブ"),
])

theme("netmusic", "ジャンル", "ボカロ・ネット発", "ボーカロイドや動画・SNSから広がった曲", [
    ("supercell", "メルト"), ("supercell", "君の知らない物語"), ("黒うさP", "千本桜"), ("ハチ", "マトリョシカ"),
    ("ハチ", "砂の惑星"), ("DECO*27", "ゴーストルール"), ("DECO*27", "ヴァンパイア"), ("DECO*27", "ラビットホール"),
    ("ピノキオピー", "神っぽいな"), ("じん", "カゲロウデイズ"), ("wowaka", "ローリンガール"),
    ("YOASOBI", "夜に駆ける"), ("ヨルシカ", "ただ君に晴れ"), ("ヨルシカ", "だから僕は音楽を辞めた"),
    ("ずっと真夜中でいいのに。", "秒針を噛む"), ("Eve", "ドラマツルギー"), ("Ado", "うっせぇわ"), ("バルーン", "シャルル"),
    ("稲葉曇", "ラグトレイン"), ("Kanaria", "KING"), ("Orangestar", "アスノヨゾラ哨戒班"), ("Chinozo", "グッバイ宣言"),
    ("なとり", "Overdose"), ("imase", "NIGHT DANCER"), ("tuki.", "晩餐歌"), ("yama", "春を告げる"),
    ("星街すいせい", "Stellar Stellar"), ("米津玄師", "Lemon"), ("Tani Yuuki", "W/X/Y"), ("瑛人", "香水"),
])

theme("jpop", "種別", "邦楽の定番", "世代を超えて歌い継がれる日本の名曲", [
    ("坂本九", "上を向いて歩こう"), ("美空ひばり", "川の流れのように"), ("サザンオールスターズ", "いとしのエリー"),
    ("中島みゆき", "糸"), ("松任谷由実", "春よ、来い"), ("山口百恵", "いい日旅立ち"), ("井上陽水", "少年時代"),
    ("Mr.Children", "innocent world"), ("スピッツ", "ロビンソン"), ("宇多田ヒカル", "First Love"),
    ("DREAMS COME TRUE", "未来予想図II"), ("小田和正", "ラブ・ストーリーは突然に"), ("槇原敬之", "どんなときも。"),
    ("ZARD", "負けないで"), ("B'z", "ultra soul"), ("尾崎豊", "I LOVE YOU"), ("THE BLUE HEARTS", "リンダ リンダ"),
    ("長渕剛", "乾杯"), ("安全地帯", "ワインレッドの心"), ("竹内まりや", "駅"), ("山下達郎", "クリスマス・イブ"),
    ("松田聖子", "赤いスイートピー"), ("中森明菜", "DESIRE"), ("米米CLUB", "君がいるだけで"),
    ("SMAP", "世界に一つだけの花"), ("一青窈", "ハナミズキ"), ("MISIA", "Everything"), ("平井堅", "瞳をとじて"),
    ("森山直太朗", "さくら(独唱)"), ("中島美嘉", "雪の華"), ("いきものがかり", "ありがとう"), ("コブクロ", "蕾"),
    ("星野源", "恋"), ("米津玄師", "Lemon"), ("あいみょん", "マリーゴールド"), ("Official髭男dism", "Pretender"),
    ("YOASOBI", "夜に駆ける"), ("King Gnu", "白日"), ("久保田早紀", "異邦人"), ("寺尾聰", "ルビーの指環"),
    ("GLAY", "HOWEVER"), ("福山雅治", "桜坂"),
])

theme("western", "種別", "洋楽の定番", "日本でもよく知られる洋楽の名曲", [
    ("The Beatles|ビートルズ", "Let It Be"), ("The Beatles|ビートルズ", "Hey Jude"), ("The Beatles|ビートルズ", "Yesterday"),
    ("Queen|クイーン", "Bohemian Rhapsody"), ("Queen|クイーン", "We Will Rock You"),
    ("Michael Jackson|マイケル・ジャクソン", "Thriller"), ("Michael Jackson|マイケル・ジャクソン", "Billie Jean"),
    ("Carpenters|カーペンターズ", "Yesterday Once More"), ("Carpenters|カーペンターズ", "Top of the World"),
    ("ABBA", "Dancing Queen"), ("Eagles|イーグルス", "Hotel California"),
    ("Simon & Garfunkel|サイモン&ガーファンクル", "Bridge Over Troubled Water"), ("Elton John|エルトン・ジョン", "Your Song"),
    ("John Lennon|ジョン・レノン", "Imagine"), ("Stevie Wonder|スティーヴィー・ワンダー", "Isn't She Lovely"),
    ("Bee Gees|ビー・ジーズ", "Stayin' Alive"), ("Earth, Wind & Fire|アース・ウィンド・アンド・ファイアー", "September"),
    ("Whitney Houston|ホイットニー・ヒューストン", "I Will Always Love You"), ("Madonna|マドンナ", "Like a Virgin"),
    ("Cyndi Lauper|シンディ・ローパー", "Girls Just Want to Have Fun"), ("Bon Jovi|ボン・ジョヴィ", "Livin' on a Prayer"),
    ("Wham!|ワム!", "Wake Me Up Before You Go-Go"), ("a-ha", "Take On Me"),
    ("Celine Dion|セリーヌ・ディオン", "My Heart Will Go On"), ("Mariah Carey|マライア・キャリー", "Hero"),
    ("Backstreet Boys|バックストリート・ボーイズ", "I Want It That Way"), ("Nirvana|ニルヴァーナ", "Smells Like Teen Spirit"),
    ("Oasis|オアシス", "Don't Look Back in Anger"), ("Avril Lavigne|アヴリル・ラヴィーン", "Complicated"),
    ("Beyoncé|ビヨンセ", "Crazy in Love"), ("Bruno Mars|ブルーノ・マーズ", "Just the Way You Are"),
    ("Taylor Swift|テイラー・スウィフト", "Shake It Off"), ("Ed Sheeran|エド・シーラン", "Shape of You"),
    ("Adele|アデル", "Rolling in the Deep"), ("Lady Gaga|レディー・ガガ", "Poker Face"), ("Maroon 5|マルーン5", "Sugar"),
    ("Coldplay|コールドプレイ", "Viva la Vida"), ("Mark Ronson|マーク・ロンソン", "Uptown Funk"),
    ("The Weeknd|ザ・ウィークエンド", "Blinding Lights"), ("Billie Eilish|ビリー・アイリッシュ", "bad guy"),
    ("Olivia Rodrigo|オリヴィア・ロドリゴ", "drivers license"), ("Daft Punk|ダフト・パンク", "Get Lucky"),
    ("The Rolling Stones|ローリング・ストーンズ", "(I Can't Get No) Satisfaction"),
])

theme("kpop", "種別", "K-POP", "日本でも人気の韓国のヒット曲", [
    ("BTS", "Dynamite"), ("BTS", "Butter"), ("BTS", "Spring Day"), ("BTS", "Boy With Luv"),
    ("BLACKPINK", "DDU-DU DDU-DU"), ("BLACKPINK", "How You Like That"), ("TWICE", "TT"), ("TWICE", "What is Love?"),
    ("TWICE", "FANCY"), ("PSY", "Gangnam Style"), ("KARA", "ミスター"), ("少女時代|Girls' Generation", "Gee"),
    ("BIGBANG", "FANTASTIC BABY"), ("東方神起", "Why? (Keep Your Head Down)"), ("EXO", "Growl"),
    ("Red Velvet", "Psycho"), ("IU", "Good Day"), ("SEVENTEEN", "Super"), ("Stray Kids", "God's Menu"),
    ("ITZY", "DALLA DALLA"), ("IVE", "LOVE DIVE"), ("IVE", "I AM"), ("NewJeans", "Hype Boy"), ("NewJeans", "Ditto"),
    ("NewJeans", "Super Shy"), ("LE SSERAFIM", "ANTIFRAGILE"), ("aespa", "Next Level"), ("aespa", "Supernova"),
    ("(G)I-DLE|i-dle", "Queencard"), ("2NE1", "I AM THE BEST"), ("ROSÉ", "APT."), ("Jung Kook", "Seven"),
    ("ILLIT", "Magnetic"), ("NCT 127", "Kick It"), ("BoA", "VALENTI"),
])


def _n(v):
    return itunes._norm(v)


def _base(v):
    """曲名の比較用：末尾の括弧書き・〜以降の副題を外して正規化。"""
    t = unicodedata.normalize("NFKC", v or "").lower()
    t = itunes.VERSION_TAG.sub("", t)
    t = re.split(r"\s*[(\[（【〜~]|\s+[-－]|\s*\bfeat\.?\s|\s*\bfeat\.", t, maxsplit=1)[0] or t
    return _n(t)


_LIVE = re.compile(r"live|ライブ|ライヴ|コンサート|concert|tour")


_NOT_ORIGINAL = re.compile(r"karaoke|カラオケ|cover|カバー|inst|オフボーカル|off\s*vocal|backing|伴奏|ガイド|guide|メロディ|music\s*box|オルゴール|piano|ピアノ|orchestra|オーケストラ|short|ショート|tv|session|セッション|acoustic|アコースティック|live|ライブ|ライヴ|mix|ミックス|ver\b|version|バージョン|edit|demo|デモ|english")


def _exact(cand, name):
    return bool(name) and itunes.song_title_norm(name) == _n(cand)


def _title_ok(cand, name):
    if not name:
        return False
    if _exact(cand, name):
        return True
    t = unicodedata.normalize("NFKC", name).lower()
    return _base(name) == _base(cand) and not _NOT_ORIGINAL.search(t) and not _NOT_ORIGINAL.search(unicodedata.normalize("NFKC", cand).lower())


def _artist_ok(aliases, name):
    a = _n(name)
    for al in aliases:
        b = _n(al)
        if a and b and (a == b or (len(b) >= 2 and b in a) or (len(a) >= 3 and a in b)):
            return True
    return False


def fetch(url):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, hashlib.sha256(url.encode()).hexdigest() + ".json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    for attempt in range(5):
        wait = _last[0] + GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tiari-themes-build/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as e:
            print(f"  retry {attempt + 1} ({e}) {url}", file=sys.stderr, flush=True)
            time.sleep(60)
    else:
        raise RuntimeError("fetch failed: " + url)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return data


def _us_names(ids):
    out = {}
    for _part, url in itunes.us_lookup_urls(ids):
        for r in fetch(url).get("results", []):
            if r.get("wrapperType") == "track":
                out[str(r.get("trackId"))] = (r.get("artistName") or "", r.get("trackName") or "")
    return out


def resolve(artist, title):
    aliases = [a for a in artist.split("|") if a]
    terms = [(f"{aliases[0]} {title}", 25)] + ([(f"{aliases[1]} {title}", 25)] if len(aliases) > 1 else [])
    terms.append((f"{aliases[-1]} {title}", 100))
    for term, limit in terms:
        rs = fetch(itunes._url("search", term=term, media="music", entity="song", limit=limit)).get("results", [])
        tracks = [r for r in rs if r.get("wrapperType") == "track" and r.get("kind") == "song" and r.get("trackId")]
        hits = [r for r in tracks if _artist_ok(aliases, r.get("artistName")) and _title_ok(title, r.get("trackName"))]
        if not hits and tracks:
            us = _us_names([r["trackId"] for r in tracks])
            hits = [r for r in tracks
                    if (_artist_ok(aliases, r.get("artistName")) or _artist_ok(aliases, us.get(str(r["trackId"]), ("", ""))[0]))
                    and (_title_ok(title, r.get("trackName")) or _title_ok(title, us.get(str(r["trackId"]), ("", ""))[1]))]
        hits = [r for r in hits if _original(r)]
        if hits:
            comps = itunes.span_compilations(rs)
            return min(hits, key=lambda r: (not _exact(title, r.get("trackName")), bool(_LIVE.search(_n(r.get("collectionName")))))
                       + itunes._pick_rank(r, comps))
    return None


_JP_VER = re.compile(r"japanese\s*(?:ver|version)|日本語")


def _original(r):
    """ライブ・リミックス・別テイク・再録音などは選ばない（K-POPの日本語版は可）。"""
    name = unicodedata.normalize("NFKC", r.get("trackName") or "").lower()
    if _LIVE.search(_n(r.get("collectionName"))) or re.search(r"edm|nonstop|non-stop|ノンストップ|dj", _n(r.get("collectionName"))) or re.search(r"first\s*take|remix|take\s*\d|reprise|dub\b|セルフカバー|self\s*cover", name):
        return False
    return not itunes.is_variant(name) or bool(_JP_VER.search(name))


def song_key(s):
    return "s:" + _n(s["artist"]) + "|" + itunes.song_title_norm(s.get("keyTitle") or s["title"])


def main():
    itunes.fetch_json = fetch
    raw, unresolved = {}, []
    todo = list(dict.fromkeys((c[0], c[1]) for *_x, songs in T for c in songs))
    for i, (a, t) in enumerate(todo, 1):
        r = resolve(a, t)
        print(f"[{i}/{len(todo)}] {'OK ' if r else 'NG '} {a} / {t}" + (f" -> {r.get('artistName')} / {r.get('trackName')} / {r.get('collectionName')}" if r else ""), flush=True)
        if r:
            raw[(a, t)] = r
        else:
            unresolved.append(f"{a} / {t}")
    en = itunes.english_titles([r["trackId"] for r in raw.values()])
    themes = []
    for tid, group, label, desc, songs in T:
        out, seen = [], set()
        for c in songs:
            r = raw.get((c[0], c[1]))
            if not r:
                continue
            s = itunes._song(r, en)
            k = song_key(s)
            if k in seen:
                continue
            seen.add(k)
            if len(c) > 2 and c[2]:
                s["note"] = c[2]
            out.append(s)
        themes.append({"id": tid, "group": group, "label": label, "description": desc, "songs": out})
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"themes": themes}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    for th in themes:
        print(f"{th['label']}: {len(th['songs'])}")
    print("UNRESOLVED:", len(unresolved))
    for u in unresolved:
        print("  -", u)


if __name__ == "__main__":
    main()
