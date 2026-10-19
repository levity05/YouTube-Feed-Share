/* Упрощённые копии реальных структур ответов YouTube (ytInitialData / youtubei browse). */
'use strict';

const richItem = (content) => ({ richItemRenderer: { content } });

function richGrid(contents) {
  return {
    responseContext: { serviceTrackingParams: [] },
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              selected: true,
              content: {
                richGridRenderer: {
                  masthead: { adSlotRenderer: { videoRenderer: { videoId: 'MASTHEADADX' } } },
                  contents: contents.map((c) => (c.richItemRenderer || c.richSectionRenderer ? c : richItem(c))),
                },
              },
            },
          },
        ],
      },
    },
    header: { feedTabbedHeaderRenderer: {} },
  };
}

function videoRenderer() {
  return {
    videoRenderer: {
      videoId: 'dQw4w9WgXcQ',
      thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 270 }] },
      title: { runs: [{ text: 'Классическое видео' }] },
      longBylineText: {
        runs: [
          {
            text: 'Канал Один',
            navigationEndpoint: { browseEndpoint: { browseId: 'UC1111111111111111111111', canonicalBaseUrl: '/@channel1' } },
          },
        ],
      },
      publishedTimeText: { simpleText: '3 дня назад' },
      lengthText: { simpleText: '10:23' },
      viewCountText: { simpleText: '1 234 567 просмотров' },
      shortViewCountText: { simpleText: '1,2 млн просмотров' },
      navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=dQw4w9WgXcQ' } }, watchEndpoint: { videoId: 'dQw4w9WgXcQ' } },
      channelThumbnailSupportedRenderers: {
        channelThumbnailWithLinkRenderer: {
          thumbnail: {
            thumbnails: [
              { url: 'https://yt3.ggpht.com/avatar1=s68', width: 68, height: 68 },
              { url: 'https://yt3.ggpht.com/avatar1=s176', width: 176, height: 176 },
            ],
          },
        },
      },
      thumbnailOverlays: [
        { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 40 } },
        { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '10:23' }, style: 'DEFAULT' } },
      ],
      menu: { menuRenderer: { items: [] } },
    },
  };
}

function lockup({ id = 'aaaaaaaaaaa', type = 'LOCKUP_CONTENT_TYPE_VIDEO', live = false, noDuration = false } = {}) {
  const badge = live
    ? { thumbnailBadgeViewModel: { text: 'В ЭФИРЕ', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' } }
    : { thumbnailBadgeViewModel: { text: '1:02:03', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } };
  return {
    lockupViewModel: {
      contentId: id,
      contentType: type,
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 270 }] },
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                progressBar: { thumbnailOverlayProgressBarViewModel: { startPercent: 100 } },
                badges: noDuration ? [] : [badge],
              },
            },
          ],
        },
      },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: 'Новый формат' },
          image: {
            decoratedAvatarViewModel: {
              avatar: { avatarViewModel: { image: { sources: [{ url: 'https://yt3.ggpht.com/avatar2=s68', width: 68, height: 68 }] } } },
              rendererContext: {
                commandContext: {
                  onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UC2222222222222222222222', canonicalBaseUrl: '/@channel2' } } },
                },
              },
            },
          },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: 'Канал Два' } }] },
                { metadataParts: [{ text: { content: '15 тыс. просмотров' } }, { text: { content: '2 недели назад' } }] },
              ],
              delimiter: ' • ',
            },
          },
        },
      },
      rendererContext: {
        commandContext: {
          onTap: {
            innertubeCommand: {
              commandMetadata: { webCommandMetadata: { url: `/watch?v=${id}` } },
              watchEndpoint: { videoId: id },
            },
          },
        },
      },
    },
  };
}

/** Снято с youtube.com 05.10.2026 (вкладка «Видео» канала), лишние ветки вырезаны. */
function lockupReal2026() {
  return {
    lockupViewModel: {
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: 'https://i.ytimg.com/vi/pRrmQUm6Zvg/hq720.jpg', width: 360, height: 202 }] },
          overlays: [
            {
              thumbnailBottomOverlayViewModel: {
                badges: [
                  {
                    thumbnailBadgeViewModel: {
                      text: '10:06',
                      badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT',
                      animationActivationTargetId: 'pRrmQUm6Zvg',
                      lottieData: { url: 'https://www.gstatic.com/youtube/img/lottie/audio_indicator/audio_indicator_v2.json' },
                      animatedText: 'Текущее видео',
                      animationActivationEntitySelectorType: 'THUMBNAIL_BADGE_ANIMATION_ENTITY_SELECTOR_TYPE_PLAYER_STATE',
                    },
                  },
                ],
              },
            },
            { animatedThumbnailOverlayViewModel: { thumbnail: { sources: [] } } },
            {
              thumbnailHoverOverlayToggleActionsViewModel: {
                buttons: [{ toggleButtonViewModel: { defaultButtonViewModel: { buttonViewModel: { iconName: 'WATCH_LATER' } } } }],
              },
            },
          ],
        },
      },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: 'Превращаем логотип YouTube в монстра' },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                {
                  metadataParts: [
                    { text: { content: 'YouTube' }, icon: { name: 'CHECK_CIRCLE_FILLED' } },
                    { text: { content: 'и Wicked Makers' }, icon: { name: 'CHECK_CIRCLE_FILLED' } },
                    {
                      text: { content: '3,3 млн' },
                      accessibilityLabel: '3,3 миллиона просмотров',
                      leadingIcon: { name: 'PLAY_ARROW_OUTLINED' },
                    },
                    { text: { content: '4 дн. назад' }, accessibilityLabel: '4 дня назад' },
                  ],
                },
              ],
            },
          },
          menuButton: { buttonViewModel: { iconName: 'MORE_VERT' } },
        },
      },
      contentId: 'pRrmQUm6Zvg',
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      rendererContext: {
        commandContext: {
          onTap: {
            innertubeCommand: {
              commandMetadata: { webCommandMetadata: { url: '/watch?v=pRrmQUm6Zvg' } },
              watchEndpoint: { videoId: 'pRrmQUm6Zvg' },
            },
          },
        },
      },
    },
  };
}

function shortsShelf() {
  const short = (id, title) =>
    richItem({
      shortsLockupViewModel: {
        entityId: `shorts-shelf-item-${id}`,
        onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } },
        overlayMetadata: { primaryText: { content: title }, secondaryText: { content: '2 млн просмотров' } },
      },
    });
  return {
    richSectionRenderer: {
      content: {
        richShelfRenderer: {
          title: { runs: [{ text: 'Shorts' }] },
          contents: [short('sssssssssss', 'Шорт один'), richItem({ reelItemRenderer: { videoId: 'ttttttttttt', headline: { simpleText: 'Шорт два' } } })],
        },
      },
    },
  };
}

/** Строка «Посмотреть позже» (playlistVideoRenderer). */
function playlistVideo(id, { playable = true, lengthText = true } = {}) {
  return {
    playlistVideoRenderer: {
      videoId: id,
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
      title: { runs: [{ text: playable ? `Отложенное ${id}` : '[Удаленное видео]' }] },
      index: { simpleText: '1' },
      shortBylineText: {
        runs: [{ text: 'Канал Три', navigationEndpoint: { browseEndpoint: { browseId: 'UC3333333333333333333333', canonicalBaseUrl: '/@channel3' } } }],
      },
      ...(lengthText ? { lengthText: { simpleText: '7:05' } } : {}),
      lengthSeconds: '425',
      navigationEndpoint: { watchEndpoint: { videoId: id, playlistId: 'WL', index: 0 } },
      isPlayable: playable,
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '7:05' }, style: 'DEFAULT' } }],
      videoInfo: { runs: [{ text: '12 тыс. просмотров' }, { text: ' • ' }, { text: '2 года назад' }] },
    },
  };
}

function watchLaterPage(items) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: items } }] } }],
                },
              },
            },
          },
        ],
      },
    },
  };
}

function historySection(title, items) {
  return {
    itemSectionRenderer: {
      header: title ? { itemSectionHeaderRenderer: { title: { runs: [{ text: title }] } } } : undefined,
      contents: items,
    },
  };
}

function historyVideo(id, percent) {
  const v = videoRenderer().videoRenderer;
  return {
    videoRenderer: {
      ...v,
      videoId: id,
      thumbnailOverlays: [
        { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: percent } },
        { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '10:00' }, style: 'DEFAULT' } },
      ],
      lengthText: { simpleText: '10:00' },
    },
  };
}

function historyPage(sections) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: sections } } } }],
      },
    },
  };
}

function continuation(items) {
  return {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [...items.map(richItem), { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } }],
        },
      },
    ],
  };
}

function reload(items) {
  return {
    onResponseReceivedActions: [
      { reloadContinuationItemsCommand: { slot: 'RELOAD_CONTINUATION_SLOT_HEADER', continuationItems: [] } },
      { reloadContinuationItemsCommand: { slot: 'RELOAD_CONTINUATION_SLOT_BODY', continuationItems: items.map(richItem) } },
    ],
  };
}

function manyVideos(n) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const words = ['Как', 'собрать', 'лучший', 'обзор', 'музыка', 'игра', 'новости', 'рецепт', 'путешествие', 'гайд', 'стрим', 'подкаст'];
  return Array.from({ length: n }, (_, i) => ({
    id: Array.from({ length: 11 }, (_, j) => alphabet[(i * 7 + j * 13 + i * j) % 64]).join(''),
    title: Array.from({ length: 6 }, (_, j) => words[(i + j * 5) % words.length]).join(' ') + ` #${i}`,
    channel: `Канал ${i % 17}`,
    channelUrl: `/@channel${i % 17}`,
    avatar: `https://yt3.ggpht.com/ytc/AIdro_${'x'.repeat(40)}${i % 17}=s68-c-k-c0x00ffffff-no-rj`,
    duration: `${(i % 59) + 1}:${String(i % 60).padStart(2, '0')}`,
    views: `${(i % 900) + 1} тыс. просмотров`,
    published: `${(i % 11) + 1} дней назад`,
  }));
}

module.exports = {
  richGrid,
  videoRenderer,
  lockup,
  lockupReal2026,
  shortsShelf,
  playlistVideo,
  watchLaterPage,
  historySection,
  historyVideo,
  historyPage,
  continuation,
  reload,
  manyVideos,
};
