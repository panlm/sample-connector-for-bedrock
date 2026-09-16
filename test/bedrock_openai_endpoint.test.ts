import { describe, it, expect } from 'vitest';
import {
    endpointConfig,
    toEndpointModelId,
    modelFamily,
    trimInferenceParams,
    supportsThinking,
    resolveAuthMode,
} from '../src/util/bedrock_openai_endpoint';

// 单测点② endpoint → { baseURL, SigV4 service name }
describe('endpointConfig (单测点②)', () => {
    it('runtime → service name bedrock + runtime host', () => {
        expect(endpointConfig('bedrock-runtime', 'us-west-2')).toEqual({
            baseURL: 'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1',
            sigV4ServiceName: 'bedrock',
        });
    });

    it('mantle → service name bedrock-mantle + mantle host', () => {
        expect(endpointConfig('bedrock-mantle', 'us-west-2')).toEqual({
            baseURL: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1',
            sigV4ServiceName: 'bedrock-mantle',
        });
    });

    it('region 反映到 host（不硬编码）', () => {
        expect(endpointConfig('bedrock-runtime', 'eu-central-1').baseURL).toBe(
            'https://bedrock-runtime.eu-central-1.amazonaws.com/openai/v1',
        );
        expect(endpointConfig('bedrock-mantle', 'ap-northeast-1').baseURL).toBe(
            'https://bedrock-mantle.ap-northeast-1.api.aws/openai/v1',
        );
    });

    it('baseURL 覆盖生效，但 service name 仍按 endpointType 推导', () => {
        const r = endpointConfig('bedrock-mantle', 'us-west-2', 'https://私有.example/openai/v1');
        expect(r.baseURL).toBe('https://私有.example/openai/v1');
        expect(r.sigV4ServiceName).toBe('bedrock-mantle');
    });
});

// 单测点③ modelId 形态换算
describe('toEndpointModelId (单测点③)', () => {
    it('mantle 去掉 global. 前缀', () => {
        expect(toEndpointModelId('global.openai.gpt-6-astra', 'bedrock-mantle')).toBe('openai.gpt-6-astra');
    });
    it('mantle 去掉 us. 前缀', () => {
        expect(toEndpointModelId('us.openai.gpt-5.6-terra', 'bedrock-mantle')).toBe('openai.gpt-5.6-terra');
    });
    it('runtime 原样保留前缀', () => {
        expect(toEndpointModelId('global.openai.gpt-6-astra', 'bedrock-runtime')).toBe('global.openai.gpt-6-astra');
    });
    it('裸 modelId（gpt-oss ON_DEMAND）两端都原样', () => {
        expect(toEndpointModelId('openai.gpt-oss-120b-1:0', 'bedrock-mantle')).toBe('openai.gpt-oss-120b-1:0');
        expect(toEndpointModelId('openai.gpt-oss-120b-1:0', 'bedrock-runtime')).toBe('openai.gpt-oss-120b-1:0');
    });
    it('modelIdOverrides 命中优先', () => {
        const ov = { 'bedrock-mantle': 'openai.override-model', 'bedrock-runtime': 'global.openai.override-model' };
        expect(toEndpointModelId('global.openai.gpt-6-astra', 'bedrock-mantle', ov)).toBe('openai.override-model');
        expect(toEndpointModelId('global.openai.gpt-6-astra', 'bedrock-runtime', ov)).toBe('global.openai.override-model');
    });
});

// 单测点① 参数裁剪家族分支
describe('modelFamily + trimInferenceParams (单测点①)', () => {
    it('modelFamily 判定', () => {
        expect(modelFamily('openai.gpt-6-astra')).toBe('gpt-56-or-6');
        expect(modelFamily('global.openai.gpt-6-astra')).toBe('gpt-56-or-6');
        expect(modelFamily('openai.gpt-5.6-terra')).toBe('gpt-56-or-6');
        expect(modelFamily('openai.gpt-oss-120b-1:0')).toBe('gpt-oss');
        expect(modelFamily('openai.gpt-oss-safeguard-20b')).toBe('gpt-oss');
        expect(modelFamily('anthropic.claude-3')).toBe('other');
        expect(modelFamily('')).toBe('other');
    });

    it('gpt-6 + temperature 0.7 → 剔除 temperature', () => {
        expect(trimInferenceParams('openai.gpt-6-astra', { temperature: 0.7 })).toEqual({});
    });
    it('gpt-6 + temperature 1 → 保留 temperature=1（幂等）', () => {
        expect(trimInferenceParams('openai.gpt-6-astra', { temperature: 1 })).toEqual({ temperature: 1 });
    });
    it('gpt-6 剔除 top_p / reasoning_effort', () => {
        expect(
            trimInferenceParams('openai.gpt-6-astra', { temperature: 0.7, top_p: 0.5, reasoning_effort: 'high' }),
        ).toEqual({});
    });
    it('gpt-oss + temperature 0.7 / top_p → 原样透传（不误伤）', () => {
        expect(
            trimInferenceParams('openai.gpt-oss-120b-1:0', { temperature: 0.7, top_p: 0.9 }),
        ).toEqual({ temperature: 0.7, top_p: 0.9 });
    });
    it('gpt-oss + reasoning_effort → 透传', () => {
        expect(
            trimInferenceParams('openai.gpt-oss-20b-1:0', { reasoning_effort: 'low' }),
        ).toEqual({ reasoning_effort: 'low' });
    });
    it('未传任何值 → 空对象（不注入默认）', () => {
        expect(trimInferenceParams('openai.gpt-6-astra', {})).toEqual({});
        expect(trimInferenceParams('openai.gpt-oss-120b-1:0', {})).toEqual({});
    });
});

// 单测点④ 三种出站认证优先级
describe('resolveAuthMode (单测点④)', () => {
    it('配 bearerToken（+其它）→ bearer 优先', () => {
        expect(resolveAuthMode({ bearerToken: 'bedrock-api-key-x', credentials: [{ accessKeyId: 'a' }] })).toBe('bearer');
    });
    it('无 bearer 但有非空 credentials → aksk', () => {
        expect(resolveAuthMode({ credentials: [{ accessKeyId: 'a', secretAccessKey: 'b' }] })).toBe('aksk');
    });
    it('两者都无 → default', () => {
        expect(resolveAuthMode({})).toBe('default');
        expect(resolveAuthMode({ region: 'us-west-2' })).toBe('default');
    });
    it('空 credentials 数组 → default', () => {
        expect(resolveAuthMode({ credentials: [] })).toBe('default');
    });
    it('null / undefined config → default', () => {
        expect(resolveAuthMode(null)).toBe('default');
        expect(resolveAuthMode(undefined)).toBe('default');
    });
});

// PIPE-124 缺陷 2：thinking 家族门控（唯一实现，与 modelFamily 同模块）。
describe('supportsThinking', () => {
    it('anthropic 家族 → true', () => {
        expect(supportsThinking('anthropic.claude-3-5-sonnet')).toBe(true);
        expect(supportsThinking('global.anthropic.claude-opus-5')).toBe(true);
    });
    it('GPT 系家族 → false', () => {
        expect(supportsThinking('global.openai.gpt-6-astra')).toBe(false);
        expect(supportsThinking('openai.gpt-oss-120b-1:0')).toBe(false);
        expect(supportsThinking('openai.gpt-5.6')).toBe(false);
    });
    it('其它 / 空 → false', () => {
        expect(supportsThinking('deepseek.r1')).toBe(false);
        expect(supportsThinking('')).toBe(false);
    });
});
