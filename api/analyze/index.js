import axios from 'axios';
import cheerio from 'cheerio';
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 50 // 每个IP限制50次请求
});

async function fetchWebContent(url) {
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NewsVerifierBot/1.0'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // 智能正文提取
        const contentSelectors = [
            'article', 
            '.article-content',
            '[itemprop="articleBody"]',
            'main',
            'body'
        ];

        for (const selector of contentSelectors) {
            const content = $(selector).text();
            if (content.length > 500) {
                return content.replace(/\s+/g, ' ').trim().substring(0, 3000);
            }
        }
        
        throw new Error('无法识别新闻正文内容');
    } catch (error) {
        console.error('抓取失败:', error);
        throw new Error('网页内容获取失败：' + error.message);
    }
}

export default async function handler(req, res) {
    await limiter(req, res);
    
    // 设置CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: '仅支持POST请求' });

    try {
        const { content, isURL } = req.body;
        if (!content) return res.status(400).json({ error: '内容不能为空' });

        let analysisContent = content;
        
        // URL处理逻辑
        if (isURL) {
            // 安全验证
            if (!/^https?:\/\//i.test(content)) {
                return res.status(400).json({ error: '无效链接格式' });
            }

            // 域名白名单（示例配置）
            const allowedDomains = ['news.cn', 'xinhuanet.com', 'people.com.cn'];
            const url = new URL(content);
            if (!allowedDomains.some(d => url.hostname.endsWith(d))) {
                return res.status(403).json({ error: '暂不支持该新闻网站' });
            }

            // 抓取网页内容
            analysisContent = await fetchWebContent(content);
        }

        // DeepSeek API调用
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: `作为新闻真实性分析专家，请根据以下维度进行评分和分析：
                        1. 来源可信度（0-30分）
                        2. 事实准确性（0-50分）
                        3. 逻辑一致性（0-20分）
                        总分为三项之和（0-100分）
                        
                        请返回严格遵循以下JSON格式：
                        {
                            "scores": { "total": 总分, "source": 来源得分, "fact": 事实得分, "logic": 逻辑得分 },
                            "analysis": "整体分析",
                            "keyPoints": ["要点1", "要点2", "要点3"],
                            "summary": "总结建议"
                        }`
                    },
                    { role: 'user', content: analysisContent }
                ],
                temperature: 0.2
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'API请求失败');

        const result = parseResult(data.choices[0].message.content);
        res.status(200).json(result);
        
    } catch (error) {
        console.error('服务器错误:', error);
        res.status(500).json({
            error: error.message,
            scores: { total: 0, source: 0, fact: 0, logic: 0 },
            analysis: "分析服务暂时不可用",
            keyPoints: [],
            summary: "请稍后重试"
        });
    }
}

function parseResult(text) {
    try {
        const jsonStr = text.match(/\{[\s\S]*\}/)[0];
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('解析错误:', e);
        return {
            scores: { total: 0, source: 0, fact: 0, logic: 0 },
            analysis: "解析分析结果时发生错误",
            keyPoints: [],
            summary: "请尝试重新提交分析"
        };
    }
}