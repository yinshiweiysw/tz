<template>
  <div class="chat-box">
    <t-chat
        ref="chatRef"
        :clear-history="chatList.length > 0 && !isStreamLoad"
        :data="chatList"
        :text-loading="loading"
        :is-stream-load="isStreamLoad"
        style="height: 100%"
        @scroll="handleChatScroll"
        @clear="clearConfirm"
    >
      <!-- eslint-disable vue/no-unused-vars -->
      <template #content="{ item, index }">
        <t-chat-reasoning v-if="item.role === 'assistant'"  expand-icon-placement="right">
          <t-chat-loading v-if="isStreamLoad" text="思考中..." />
          <t-chat-content v-if="item.reasoning.length > 0" :content="item.reasoning" />
        </t-chat-reasoning>
        <t-chat-content v-if="item.content.length > 0" :content="item.content" />
      </template>
      <template #actions="{ item, index }">
        <t-chat-action
            :content="item.content"
            :operation-btn="['copy']"
            @operation="handleOperation"
        />
      </template>
      <template #footer>
<!--        <t-chat-input :stop-disabled="isStreamLoad" @send="inputEnter" @stop="onStop"> </t-chat-input>-->
          <t-chat-sender
              ref="chatSenderRef"
              v-model="inputValue"
              class="chat-sender"
              :textarea-props="{
                placeholder: '请输入消息...',
              }"
              :loading="loading"
              :stop-disabled="isStreamLoad"
              @send="inputEnter"
              @stop="onStop"
          >
            <template #suffix>
              <!-- 监听键盘回车发送事件需要在sender组件监听 -->
              <t-button theme="default" variant="text" size="large" class="btn" @click="inputEnter"> 发送 </t-button>
            </template>
            <template #prefix>
              <NFlex>
                <NSelect
                    v-model:value="selectValue"
                    :options="selectOptions"
                    label-field="name" value-field="ID"
                    size="tiny"
                    style="width: 200px;"
                />
              </NFlex>
            </template>
          </t-chat-sender>

      </template>
    </t-chat>
    <t-button v-show="isShowToBottom" variant="text" class="bottomBtn" @click="backBottom">
      <div class="to-bottom">
        <ArrowDownIcon />
      </div>
    </t-button>
  </div>
</template>
<script setup lang="ts">
import {ref, onMounted, h, onBeforeUnmount, onBeforeMount} from 'vue';
import {ArrowDownIcon, CheckCircleIcon, SystemSumIcon} from 'tdesign-icons-vue-next';
const fetchCancel = ref(null);
const loading = ref(false);

const inputValue = ref('');
// 流式数据加载中
const isStreamLoad = ref(false);

const chatRef = ref(null);
const isShowToBottom = ref(false);

const icon = ref('https://raw.githubusercontent.com/ArvinLovegood/go-stock/master/build/appicon.png');
import {darkTheme, NFlex, NImage,NSelect} from "naive-ui";
import {ChatWithAgent, GetAiConfigs, GetConfig, GetSponsorInfo, GetVersionInfo} from "../../wailsjs/go/main/App";
import {EventsOff, EventsOn} from '../../wailsjs/runtime'
import 'tdesign-vue-next/es/style/index.css';


const allowToolTip = ref(true);
const chatSenderRef = ref(null);
const selectOptions = ref([]);
const selectValue = ref("default");

// 定义事件处理函数，方便在挂载和卸载时管理
const handleAgentMessage = (data) => {
  console.log(data)
  if(data['role']==="assistant"){
    loading.value = false;
    const lastItem = chatList.value[0];
    if (data['reasoning_content']){
      lastItem.reasoning += data['reasoning_content'];
    }
    if (data['content']){
      lastItem.content +=data['content'];
    }
    if(data['tool_calls']){
      for (const tool of  data['tool_calls']) {
          console.log(tool.id, tool.type, tool.function.name, tool.function.arguments);
        lastItem.reasoning += "\n```"+tool.function.name+"\n" +
            "参数："+ (tool.function.arguments?tool.function.arguments:"无")+
            "\n```\n";
      }
    }
  }
  if(data['response_meta']&&data['response_meta'].finish_reason==="stop"){
    isStreamLoad.value = false;
    loading.value = false;
  }
}

onBeforeUnmount(() => {
  EventsOff("agent-message", handleAgentMessage)
})

onBeforeMount(() => {
  // 每次挂载前都重新注册事件监听
  EventsOn("agent-message", handleAgentMessage)
  GetAiConfigs().then(res=>{
    console.log(res)
    selectOptions.value = res
    selectValue.value = res[0].ID
  })
})

onMounted(() => {
  //chatRef.value.scrollToBottom();

  GetConfig().then((res) => {
    if (res.darkTheme) {
      document.documentElement.setAttribute("theme-mode", "dark");
    } else {
      document.documentElement.removeAttribute("theme-mode");    }
  })


  GetVersionInfo().then((res) => {
    icon.value = res.icon;
  });

});

// 滚动到底部
const backBottom = () => {
  chatRef.value.scrollToBottom({
    behavior: 'smooth',
  });
};
// 是否显示回到底部按钮
const handleChatScroll = function ({ e }) {
  const scrollTop = e.target.scrollTop;
  isShowToBottom.value = scrollTop < 0;
};
// 清空消息
const clearConfirm = function () {
  chatList.value = [];
};
const handleOperation = function (type, options) {
  console.log('handleOperation', type, options);
};
// 倒序渲染
const chatList = ref([
  // {
  //   content: `模型由<span>hunyuan</span>变为<span>GPT4</span>`,
  //   role: 'model-change',
  //   reasoning: '',
  // },
  {
    avatar: h(NImage, { src: icon.value, height: '48px', width: '48px'}),
    name: 'Go-Stock AI',
    datetime: '',
    reasoning: '',
    content: '我是您的AI赋能股票分析助手,您可以问我任何关于股票投资方面的问题。',
    role: 'assistant',
    duration: 10,
  },
  {
    avatar: 'https://tdesign.gtimg.com/site/avatar.jpg',
    name: '宇宙无敌大韭菜',
    datetime: '',
    content: '介绍下自己？',
    role: 'user',
    reasoning: '',
  },
]);

const onStop = function () {
  if (fetchCancel.value) {
    fetchCancel.value.controller.close();
    loading.value = false;
    isStreamLoad.value = false;
  }
};

const inputEnter = function () {
  if (isStreamLoad.value) {
    return;
  }
  if (!inputValue.value) return;
  const params = {
    avatar: 'https://tdesign.gtimg.com/site/avatar.jpg',
    name: '宇宙无敌大韭菜',
    datetime: new Date().toDateString(),
    content: inputValue.value,
    role: 'user',
  };
  chatList.value.unshift(params);
  // 空消息占位
  const params2 = {
    avatar:  h(NImage, { src: icon.value, height: '48px', width: '48px'}),
    name: 'Go-Stock AI',
    datetime: new Date().toDateString(),
    content: '',
    reasoning: '',
    role: 'assistant',
  };
  chatList.value.unshift(params2);
  loading.value = true;
  isStreamLoad.value = true;
  ChatWithAgent(inputValue.value,selectValue.value,0)
};
</script>
<style lang="less">
/* 应用滚动条样式 */
::-webkit-scrollbar-thumb {
  background-color: var(--td-scrollbar-color);
}
::-webkit-scrollbar-thumb:horizontal:hover {
  background-color: var(--td-scrollbar-hover-color);
}
::-webkit-scrollbar-track {
  background-color: var(--td-scroll-track-color);
}
.chat-box {
  position: relative;
  height: 100%;
  margin: 5px 10px 5px 10px;
  text-align: left;
  .bottomBtn {
    position: absolute;
    left: 50%;
    margin-left: -20px;
    bottom: 210px;
    padding: 0;
    border: 0;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    box-shadow: 0px 8px 10px -5px rgba(0, 0, 0, 0.08), 0px 16px 24px 2px rgba(0, 0, 0, 0.04),
    0px 6px 30px 5px rgba(0, 0, 0, 0.05);
  }
  .to-bottom {
    width: 40px;
    height: 40px;
    border: 1px solid #dcdcdc;
    box-sizing: border-box;
    background: var(--td-bg-color-container);
    border-radius: 50%;
    font-size: 24px;
    line-height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    .t-icon {
      font-size: 24px;
    }
  }
}

.model-select {
  display: flex;
  align-items: center;
  .t-select {
    width: 112px;
    height: 32px;
    margin-right: 8px;
    .t-input {
      border-radius: 32px;
      padding: 0 15px;
    }
  }
  .check-box {
    width: 112px;
    height: 32px;
    border-radius: 32px;
    border: 0;
    background: #e7e7e7;
    color: rgba(0, 0, 0, 0.9);
    box-sizing: border-box;
    flex: 0 0 auto;
    .t-button__text {
      display: flex;
      align-items: center;
      justify-content: center;
      span {
        margin-left: 4px;
      }
    }
  }
  .check-box.is-active {
    border: 1px solid #d9e1ff;
    background: #f2f3ff;
    color: var(--td-brand-color);
  }
}


.chat-sender {
  .btn {
    color: var(--td-text-color-disabled);
    border: none;
    &:hover {
      color: var(--td-brand-color-hover);
      border: none;
      background: none;
    }
  }
  .btn.t-button {
    height: var(--td-comp-size-m);
    padding: 0;
  }
  .model-select {
    display: flex;
    align-items: center;
    .t-select {
      width: 112px;
      height: var(--td-comp-size-m);
      margin-right: var(--td-comp-margin-s);
      .t-input {
        border-radius: 32px;
        padding: 0 15px;
      }
      .t-input.t-is-focused {
        box-shadow: none;
      }
    }
    .check-box {
      width: 112px;
      height: var(--td-comp-size-m);
      border-radius: 32px;
      border: 0;
      background: var(--td-bg-color-component);
      color: var(--td-text-color-primary);
      box-sizing: border-box;
      flex: 0 0 auto;
      .t-button__text {
        display: flex;
        align-items: center;
        justify-content: center;
        span {
          margin-left: var(--td-comp-margin-xs);
        }
      }
    }
    .check-box.is-active {
      border: 1px solid var(--td-brand-color-focus);
      background: var(--td-brand-color-light);
      color: var(--td-text-color-brand);
    }
  }
}

</style>